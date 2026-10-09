import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { configurationRequest } from "../configuration/http";
import { taskCommands } from "./tasks";
import type { JsonBusinessInput } from "./index";
import * as task from "./handlers/tasks/[id]/route";
import * as abort from "./handlers/tasks/[id]/abort/route";
type Handler = (request: ReturnType<typeof configurationRequest>, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const handlers = { "tasks/[id]": task, "tasks/[id]/abort": abort } as unknown as Record<string, Record<string, Handler>>;
export async function dispatchTaskLifecycleRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: {route: string; params: Record<string,string>}): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  const handler = async () => {
    const id = target.params.id;
    if (!validTaskLifecycleId(id)) return Response.json({error:"Invalid task ID"}, {status:400});
    const response = await handlers[target.route][input.method](request, {params: Promise.resolve({id})});
    if (response.status === 304) return response;
    const body = await response.json();
    if (response.status >= 500) body.error = "タスクの処理結果を確認できません";
    return Response.json(body, {status: response.status, headers: response.headers});
  };
  const response = input.method === "GET" ? await handler() : await taskCommands.run({operationId: input.operationId,handler});
  const headers: Record<string,string> = {};
  for (const key of ["cache-control","etag"]) if(response.headers.has(key))headers[key]=response.headers.get(key)!;
  return {status:response.status,headers,body:response.status===304?null:await response.json()};
}
