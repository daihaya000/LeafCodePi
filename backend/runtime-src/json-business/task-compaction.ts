import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { taskCompactionBodyLimit, publicTaskCompactionBody } from "@shared/task-compaction-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as compact from "./handlers/tasks/[id]/compact/route";
import * as abort from "./handlers/tasks/[id]/compact/abort/route";
const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir(), "task-compaction-command.json") });
/** No global execution queue: abort must be admitted while summarization awaits a provider. */
export async function dispatchTaskCompactionRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > taskCompactionBodyLimit(input.route)) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const response = await commands.run({ operationId: input.operationId, handler: async () => {
    if (!validTaskLifecycleId(target.params.id)) return Response.json({ error: "Invalid task ID" }, { status: 400 });
    const handler = target.route.endsWith("/abort") ? abort.POST : compact.POST;
    const result = await handler(request, { params: Promise.resolve({ id: target.params.id }) });
    const body = await result.json();
    // A malformed successful SDK projection cannot become a complete receipt after possible effects.
    if (!publicTaskCompactionBody(target.route, body, result.status)) return Response.json({ error: "タスク圧縮の処理結果を確認できません" }, { status: 503 });
    return Response.json(body, { status: result.status });
  } });
  return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
}
