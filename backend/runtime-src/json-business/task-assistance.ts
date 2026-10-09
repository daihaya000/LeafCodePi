import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { taskAssistanceBodyLimit, publicTaskAssistanceBody } from "@shared/task-assistance-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as progress from "./handlers/tasks/[id]/progress/route";
import * as nextAction from "./handlers/tasks/[id]/next-action/route";
import * as title from "./handlers/tasks/[id]/title/route";
import * as advice from "./handlers/tasks/[id]/permission/advice/route";
type Handler = (request: ReturnType<typeof configurationRequest>, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const handlers = { "tasks/[id]/progress": progress, "tasks/[id]/next-action": nextAction, "tasks/[id]/title": title, "tasks/[id]/permission/advice": advice } as unknown as Record<string, Record<string, Handler>>;
const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir(), "task-assistance-command.json") });
/** Concurrent generation admission: provider waits never block manual edits/Stop/answers. */
export async function dispatchTaskAssistanceRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > taskAssistanceBodyLimit(input.route)) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const response = await commands.run({ operationId: input.operationId, handler: async () => {
    if (!validTaskLifecycleId(target.params.id)) return Response.json({ error: "Invalid task ID" }, { status: 400 });
    const result = await handlers[target.route][input.method](request, { params: Promise.resolve({ id: target.params.id }) });
    const body = await result.json();
    if (result.status >= 500) body.error = "タスク進行補助の処理結果を確認できません";
    const projected = publicTaskAssistanceBody(target.route, body, result.status, input.method);
    // Invalid successful DTO after possible generation/persistence stays unknown, not complete.
    if (!projected) return Response.json({ error: "タスク進行補助の処理結果を確認できません" }, { status: 503 });
    return Response.json(projected, { status: result.status });
  } });
  return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
}
