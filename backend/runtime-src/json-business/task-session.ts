import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { TASK_SESSION_BODY_LIMIT, publicTaskSessionBody } from "@shared/task-session-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import { forkTask, revertTask, unrevertTask, promoteTask } from "../lib/task-session";
import { jsonError } from "../lib/pi/harness";
import type { JsonBusinessInput } from "./index";
const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir(), "task-session-command.json") });
type Context = { params: Promise<{ id: string }> };
type Action = "fork" | "revert" | "unrevert" | "promote";
/** Existing SDK guards own tree-edit exclusion, idle checks, Goal stop and workspace rollback. */
export async function handleTaskSessionOperation(request: ReturnType<typeof configurationRequest>, context: Context, action: Action): Promise<Response> {
  assertConfigurationOwner();
  try {
    const { id } = await context.params;
    if (action === "unrevert") return Response.json({ task: await unrevertTask(id) });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const key = action === "promote" ? "destinationPath" : "entryId";
    const value = typeof body?.[key] === "string" ? (body[key] as string).trim() : "";
    if (!value || !body || Array.isArray(body)) return Response.json({ error: `${key} が必要です` }, { status: 400 });
    // Entry IDs are opaque SDK IDs, not paths; exclude control characters, not legacy numeric IDs.
    if (action !== "promote" && (value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) return Response.json({ error: "Invalid entry ID" }, { status: 400 });
    return Response.json(action === "fork" ? await forkTask(id, value) : action === "revert" ? await revertTask(id, value) : await promoteTask(id, value));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return Response.json({ error: status >= 500 ? "タスクの会話編集結果を確認できません" : message }, { status });
  }
}
/** Concurrent admission does not place real Stop/answers behind tree editing or workspace copying. */
export async function dispatchTaskSessionRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > TASK_SESSION_BODY_LIMIT) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const response = await commands.run({ operationId: input.operationId, handler: async () => {
    if (!validTaskLifecycleId(target.params.id)) return Response.json({ error: "Invalid task ID" }, { status: 400 });
    const result = await handleTaskSessionOperation(request, { params: Promise.resolve({ id: target.params.id }) }, target.route.split("/").at(-1) as Action);
    const body = await result.json();
    // An invalid successful SDK result cannot be acknowledged complete after a possible effect.
    if (!publicTaskSessionBody(target.route, body, result.status)) return Response.json({ error: "タスクの会話編集結果を確認できません" }, { status: 503 });
    return Response.json(body, { status: result.status });
  } });
  return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
}
