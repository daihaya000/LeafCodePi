import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import type { workspaceTarget } from "@shared/workspace-contract.mjs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { configurationRequest } from "../configuration/http";
import { withGitRequestSignal } from "../lib/git";
import * as projects from "./handlers/projects/[id]/files/route";
import * as tasks from "./handlers/tasks/[id]/files/route";
import * as nextTask from "./handlers/projects/[id]/next-task/route";
import type { JsonBusinessInput } from "./index";
type Handler = (request: ReturnType<typeof configurationRequest>, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const handlers = { "projects/[id]/files": projects, "tasks/[id]/files": tasks, "projects/[id]/next-task": nextTask } as unknown as Record<string, Record<string, Handler>>;
/** Registered-root filesystem reads and direct suggestions; no configuration mutation/admission ACK. */
export async function dispatchWorkspaceRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: NonNullable<ReturnType<typeof workspaceTarget>>): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  const id = target.params.id;
  if (!id || !/^[A-Za-z0-9_:.-]{1,128}$/.test(id) || id === "." || id === "..") return { status: 400, headers: {}, body: { error: "Invalid workspace ID" } };
  try {
    const response = await withGitRequestSignal(input.signal, () => handlers[target.route][input.method](request, { params: Promise.resolve({ id }) }));
    const body = await response.json();
    if (response.status >= 500) body.error = "Workspaceの処理に失敗しました";
    const headers: Record<string, string> = { "cache-control": "no-store" };
    return { status: response.status, headers, body };
  } catch { return { status: 503, headers: { "cache-control": "no-store" }, body: { error: "Workspaceの処理に失敗しました" } }; }
}
