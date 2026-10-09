import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { TASK_SUPERVISION_BODY_LIMIT, publicTaskSupervisionBody } from "@shared/task-supervision-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as supervisor from "./handlers/tasks/[id]/supervisor/route";
import * as subagents from "./handlers/tasks/[id]/subagents/route";
const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir(), "task-supervision-command.json") });
/** Concurrent admission: a deferred supervisor notice cannot queue release/Stop/answers. */
export async function dispatchTaskSupervisionRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > TASK_SUPERVISION_BODY_LIMIT) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const invoke = async () => {
    if (!validTaskLifecycleId(target.params.id)) return Response.json({ error: "Invalid task ID" }, { status: 400 });
    const context = { params: Promise.resolve({ id: target.params.id }) };
    const response = target.route.endsWith("/supervisor") ? await supervisor.POST(request, context) : await subagents.GET(request, context);
    const projected = publicTaskSupervisionBody(target.route, await response.json(), response.status);
    if (!projected) return Response.json({ error: "タスク監督・子実行の処理結果を確認できません" }, { status: 503 });
    return Response.json(projected, { status: response.status });
  };
  const response = input.method === "GET" ? await invoke() : await commands.run({ operationId: input.operationId, handler: invoke });
  return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
}
