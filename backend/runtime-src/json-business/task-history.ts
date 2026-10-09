import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { TASK_HISTORY_BODY_LIMIT } from "@shared/task-history-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { configurationRequest } from "../configuration/http";
import { taskCommands } from "./tasks";
import type { JsonBusinessInput } from "./index";
import * as messages from "./handlers/tasks/[id]/messages/route";
import * as search from "./handlers/tasks/[id]/search/route";
import * as bookmarks from "./handlers/tasks/[id]/bookmarks/route";
type Handler=(request:ReturnType<typeof configurationRequest>,context:{params:Promise<{id:string}>})=>Promise<Response>;
const handlers={"tasks/[id]/messages":messages,"tasks/[id]/search":search,"tasks/[id]/bookmarks":bookmarks} as unknown as Record<string,Record<string,Handler>>;
export async function dispatchTaskHistoryRequest(input:JsonBusinessInput,request:ReturnType<typeof configurationRequest>,target:{route:string;params:Record<string,string>}):Promise<JsonBusinessResult>{
 assertConfigurationOwner();
 if(!input.authorized)return {status:401,headers:{},body:{error:"Unauthorized"}};
 if((input.body?.byteLength??0)>TASK_HISTORY_BODY_LIMIT)return {status:413,headers:{},body:{error:"Request body is too large"}};
 const handler=async()=>{
  const id=target.params.id;if(!validTaskLifecycleId(id))return Response.json({error:"Invalid task ID"},{status:400});
  const response=await handlers[target.route][input.method](request,{params:Promise.resolve({id})});
  const body=await response.json();if(response.status>=500)body.error="タスク履歴の処理結果を確認できません";
  return Response.json(body,{status:response.status});
 };
 const response=input.method==="GET"?await handler():await taskCommands.run({operationId:input.operationId,handler});
 return {status:response.status,headers:{"cache-control":"no-store, private"},body:await response.json()};
}
