import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { taskGoalLoopBodyLimit } from "@shared/task-goal-loop-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as goal from "./handlers/tasks/[id]/goal-loop/route";
import * as active from "./handlers/goal-loop/active/route";
const commands=createTaskConversationCommands({ledgerPath:()=>join(dataDir(),"task-goal-loop-command.json")});
type Handler=(request:ReturnType<typeof configurationRequest>,context:{params:Promise<{id:string}>})=>Promise<Response>;
const handlers={"tasks/[id]/goal-loop":goal,"goal-loop/active":active} as unknown as Record<string,Record<string,Handler>>;
/** Start/resume preparation cannot block control admission. GET is offline, never a cold-session start. */
export async function dispatchTaskGoalLoopRequest(input:JsonBusinessInput,request:ReturnType<typeof configurationRequest>,target:{route:string;params:Record<string,string>}):Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if(!input.authorized)return {status:401,headers:{},body:{error:"Unauthorized"}};
  if((input.body?.byteLength??0)>taskGoalLoopBodyLimit(input.route,input.method))return {status:413,headers:{},body:{error:"Request body is too large"}};
  const handler=async()=>{
    const id=target.params.id;
    if(target.route!=="goal-loop/active"&&!validTaskLifecycleId(id))return Response.json({error:"Invalid task ID"},{status:400});
    const response=await handlers[target.route][input.method](request,{params:Promise.resolve({id})});
    const body=await response.json();
    if(response.status>=500)body.error="Goal Loopの処理結果を確認できません";
    return Response.json(body,{status:response.status});
  };
  const response=input.method==="GET"?await handler():await commands.run({operationId:input.operationId,handler});
  return {status:response.status,headers:{"cache-control":"no-store, private"},body:await response.json()};
}
