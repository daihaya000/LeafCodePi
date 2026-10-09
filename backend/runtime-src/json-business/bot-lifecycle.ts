import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskCollectionCommands } from "@backend-core/task-collection-command.mjs";
import { botLifecycleBodyLimit, validBotLifecycleId, publicBotLifecycleBody } from "@shared/bot-lifecycle-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as collection from "./handlers/bots/route";
import * as individual from "./handlers/bots/[id]/route";
const commands = createTaskCollectionCommands({ ledgerPath: () => join(dataDir(), "bot-lifecycle-command.json") });
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
/** Serial CRUD admission; no provider generation. An admitted teardown survives client disconnect. */
export async function dispatchBotLifecycleRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > botLifecycleBodyLimit(input.route, input.method)) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const invoke = async () => {
    if (target.route !== "bots" && !validBotLifecycleId(target.params.id)) return Response.json({ error: "Invalid bot ID" }, { status: 400 });
    try {
      const handlers = (target.route === "bots" ? collection : individual) as unknown as Record<string, Handler>;
      const response = await handlers[input.method](request, { params: Promise.resolve({ id: target.params.id }) });
      if (response.status === 304) return response;
      const body = await response.json();
      if (response.status >= 500) body.error = "Bot設定の処理結果を確認できません";
      const projected = publicBotLifecycleBody(target.route, body, response.status, input.method);
      if (!projected) return Response.json({ error: "Bot設定の処理結果を確認できません" }, { status: 503 });
      return Response.json(projected, { status: response.status, headers: response.headers });
    } catch { return Response.json({ error: "Bot設定の処理結果を確認できません" }, { status: 503 }); }
  };
  const response = input.method === "GET" ? await invoke() : await commands.run({ operationId: input.operationId, handler: invoke });
  const headers: Record<string, string> = {};
  for (const key of ["cache-control", "etag"]) if (response.headers.has(key)) headers[key] = response.headers.get(key)!;
  return { status: response.status, headers, body: response.status === 304 ? null : await response.json() };
}
