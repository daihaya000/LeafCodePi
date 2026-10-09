import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskCollectionCommands } from "@backend-core/task-collection-command.mjs";
import { BACKEND_INFORMATION_BODY_LIMIT, publicBackendInformationBody } from "@shared/backend-information-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import type { JsonBusinessInput } from "./index";
import * as memory from "./handlers/memory-search/route";
import * as usage from "./handlers/sysmon/usage/route";
import * as unread from "./handlers/unread/route";
const commands = createTaskCollectionCommands({ ledgerPath: () => join(dataDir(), "unread-command.json") });
const unknown = "Backend参照・既読操作の処理結果を確認できません";
type Handler = (request: Request) => Response | Promise<Response>;
/** Search/sampling are read-only (no command ledger); unread PUT is serial durable admission. */
export async function dispatchBackendInformationRequest(input: JsonBusinessInput, request: Request): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > BACKEND_INFORMATION_BODY_LIMIT) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const invoke = async () => {
    try {
      const handlers = (input.route === "memory-search" ? memory : input.route === "sysmon/usage" ? usage : unread) as unknown as Record<string, Handler>;
      const response = await handlers[input.method](request), body = await response.json();
      const projected = publicBackendInformationBody(input.route, body, response.status, input.method);
      return projected ? Response.json(projected, { status: response.status }) : Response.json({ error: unknown }, { status: 503 });
    } catch { return Response.json({ error: unknown }, { status: 503 }); }
  };
  const response = input.route === "unread" && input.method === "PUT" ? await commands.run({ operationId: input.operationId, handler: invoke }) : await invoke();
  return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
}
