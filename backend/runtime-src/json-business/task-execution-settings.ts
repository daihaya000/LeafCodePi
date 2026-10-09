import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { TASK_EXECUTION_SETTINGS_BODY_LIMIT } from "@shared/task-execution-settings-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { configurationRequest } from "../configuration/http";
import { taskCommands } from "./tasks";
import type { JsonBusinessInput } from "./index";
import * as model from "./handlers/tasks/[id]/model/route";
import * as thinking from "./handlers/tasks/[id]/thinking/route";
import * as agent from "./handlers/tasks/[id]/agent/route";
import * as auto from "./handlers/tasks/[id]/goal-loop-auto-model/route";
type Handler = (request:ReturnType<typeof configurationRequest>, context:{params:Promise<{id:string}>})=>Promise<Response>;
const handlers = { "tasks/[id]/model": model, "tasks/[id]/thinking": thinking, "tasks/[id]/agent": agent,
  "tasks/[id]/goal-loop-auto-model": auto } as unknown as Record<string,Record<string,Handler>>;
export async function dispatchTaskExecutionSettingsRequest(input:JsonBusinessInput, request:ReturnType<typeof configurationRequest>, target:{route:string;params:Record<string,string>}):Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return {status:401,headers:{},body:{error:"Unauthorized"}};
  if ((input.body?.byteLength??0)>TASK_EXECUTION_SETTINGS_BODY_LIMIT) return {status:413,headers:{},body:{error:"Request body is too large"}};
  const response = await taskCommands.run({operationId:input.operationId,handler:async()=>{
    const id=target.params.id;
    if (!validTaskLifecycleId(id)) return Response.json({error:"Invalid task ID"},{status:400});
    const response=await handlers[target.route][input.method](request,{params:Promise.resolve({id})});
    const body=await response.json();
    if(response.status>=500) body.error="タスク設定の変更結果を確認できません";
    return Response.json(body,{status:response.status});
  }});
  return {status:response.status,headers:{"cache-control":"no-store, private"},body:await response.json()};
}
