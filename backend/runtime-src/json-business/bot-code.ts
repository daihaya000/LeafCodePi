import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { botCodeBodyLimit, publicBotCodeBody } from "@shared/bot-code-contract.mjs";
import { validBotLifecycleId } from "@shared/bot-lifecycle-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as collection from "./handlers/bots/[id]/code-session/route";
import * as individual from "./handlers/bots/[id]/code-requests/route";
const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir(), "bot-code-command.json") });
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
/** Concurrent Code admission: stop/unlink must not queue behind Code launch or continuation. */
export async function dispatchBotCodeRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > botCodeBodyLimit(input.route)) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const invoke = async () => {
    if (!validBotLifecycleId(target.params.id)) return Response.json({ error: "Invalid bot ID" }, { status: 400 });
    try {
      const handlers = (target.route.endsWith("/code-session") ? collection : individual) as unknown as Record<string, Handler>;
      const response = await handlers[input.method](request, { params: Promise.resolve({ id: target.params.id }) });
      if (response.status === 304) return response;
      const body = await response.json();
      if (response.status >= 500) body.error = "Bot Codeの処理結果を確認できません";
      const projected = publicBotCodeBody(target.route, body, response.status, input.method);
      if (!projected) return Response.json({ error: "Bot Codeの処理結果を確認できません" }, { status: 503 });
      return Response.json(projected, { status: response.status, headers: response.headers });
    } catch { return Response.json({ error: "Bot Codeの処理結果を確認できません" }, { status: 503 }); }
  };
  const response = input.method === "GET" ? await invoke() : await commands.run({ operationId: input.operationId, handler: invoke });
  const headers: Record<string, string> = {};
  for (const key of ["cache-control", "etag"]) if (response.headers.has(key)) headers[key] = response.headers.get(key)!;
  return { status: response.status, headers, body: response.status === 304 ? null : await response.json() };
}
