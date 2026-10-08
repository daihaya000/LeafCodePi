import { JSON_BUSINESS_ROUTES, jsonBusinessTarget, jsonBusinessMutates, type JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { definitionTarget } from "@shared/definition-contract.mjs";
import { dispatchDefinitionRequest } from "./definitions";
import { providerTarget } from "@shared/provider-contract.mjs";
import { dispatchProviderRequest } from "./providers";
import { providerAuthTarget } from "@shared/provider-auth-contract.mjs";
import { dispatchProviderAuthRequest } from "./provider-auth";
import { accountTarget } from "@shared/account-contract.mjs";
import { dispatchAccountRequest } from "./accounts";
import { usageTarget } from "@shared/usage-contract.mjs";
import { dispatchUsageRequest } from "./usage";
import { peerTarget } from "@shared/peer-contract.mjs";
import { dispatchPeerRequest } from "./peer";
import { taskLifecycleTarget } from "@shared/task-lifecycle-contract.mjs";
import { dispatchTaskLifecycleRequest } from "./task-lifecycle";
import { taskCollectionTarget } from "@shared/task-collection-contract.mjs";
import { dispatchTaskCollectionRequest } from "./tasks";
import { projectTarget } from "@shared/project-contract.mjs";
import { dispatchProjectRequest } from "./projects";
import { workspaceTarget } from "@shared/workspace-contract.mjs";
import { dispatchWorkspaceRequest } from "./workspace";
import { configurationRequest } from "../configuration/http";
import { withGitRequestSignal } from "../lib/git";
import { isCrossOriginRequest } from "../lib/same-origin";
import * as branches from "./handlers/git/branches/route";
import * as commit from "./handlers/git/commit/route";
import * as message from "./handlers/git/commit-message/route";
import * as init from "./handlers/git/init/route";
import * as log from "./handlers/git/log/route";
import * as merge from "./handlers/git/merge/route";
import * as pr from "./handlers/git/pr/route";
import * as pull from "./handlers/git/pull/route";
import * as push from "./handlers/git/push/route";
import * as repositories from "./handlers/git/repositories/route";
import * as rm from "./handlers/git/rm/route";
import * as show from "./handlers/git/show/route";
import * as diff from "./handlers/diff/files/route";

type Handler = (req: ReturnType<typeof configurationRequest>) => Promise<Response>;
const handlers = { "git/branches": branches, "git/commit": commit, "git/commit-message": message, "git/init": init,
  "git/log": log, "git/merge": merge, "git/pr": pr, "git/pull": pull, "git/push": push,
  "git/repositories": repositories, "git/rm": rm, "git/show": show, "diff/files": diff } as unknown as Record<string, Record<string, Handler>>;
export type JsonBusinessInput = { route: string; method: string; url: string; headers: Record<string, string>;
  authorized: boolean; operationId?: string; body?: Uint8Array; signal?: AbortSignal };
/** Node/SDK domain owner only. A response envelope retains 304/error/partial-success semantics. */
export async function dispatchJsonBusinessRequest(input: JsonBusinessInput): Promise<JsonBusinessResult> {
  const target = jsonBusinessTarget(input.route);
  if (!target) return { status: 404, headers: {}, body: { error: "Unknown business route" } };
  if (!JSON_BUSINESS_ROUTES[target.route].includes(input.method)) return { status: 405, headers: {}, body: { error: "Method not allowed" } };
  const signal = jsonBusinessMutates(input.route, input.method) ? undefined : input.signal;
  const request = configurationRequest(new Request(input.url, { method: input.method, headers: input.headers,
    signal, ...(input.body?.byteLength ? { body: new Uint8Array(input.body).slice().buffer } : {}) }), input.authorized);
  if (input.method !== "GET" && isCrossOriginRequest(request)) return { status: 403, headers: {}, body: { error: "Cross-origin request refused" } };
  const lifecycle = taskLifecycleTarget(input.route);
  if (lifecycle) return dispatchTaskLifecycleRequest(input, request, lifecycle);
  if (taskCollectionTarget(input.route)) return dispatchTaskCollectionRequest(input, request);
  if (projectTarget(input.route)) return dispatchProjectRequest(input, request);
  const workspace = workspaceTarget(input.route);
  if (workspace) return dispatchWorkspaceRequest(input, request, workspace);
  if (peerTarget(input.route)) return dispatchPeerRequest(input, request);
  if (usageTarget(input.route)) return dispatchUsageRequest(input, request);
  if (accountTarget(input.route)) return dispatchAccountRequest(input, request, target);
  if (providerAuthTarget(input.route)) return dispatchProviderAuthRequest(input, request, target);
  if (providerTarget(input.route)) return dispatchProviderRequest(input, request, target);
  if (definitionTarget(input.route)) return dispatchDefinitionRequest(input, request, target);
  const response = await withGitRequestSignal(signal, () => handlers[input.route][input.method](request));
  const headers: Record<string, string> = {};
  for (const key of ["cache-control", "etag", "x-content-type-options"]) if (response.headers.has(key)) headers[key] = response.headers.get(key)!;
  return { status: response.status, headers, body: response.status === 304 ? null : await response.json() };
}
