import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { taskConversationBodyLimit } from "@shared/task-conversation-contract.mjs";
import { validTaskLifecycleId } from "@shared/task-lifecycle-contract.mjs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as prompt from "./handlers/tasks/[id]/prompt/route";
import * as permission from "./handlers/tasks/[id]/permission/route";
import * as question from "./handlers/tasks/[id]/question/route";
const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir(), "task-conversation-command.json") });
type Handler = (request:ReturnType<typeof configurationRequest>, context:{params:Promise<{id:string}>})=>Promise<Response>;
const handlers = { "tasks/[id]/prompt": prompt, "tasks/[id]/permission": permission, "tasks/[id]/question": question } as unknown as Record<string,Record<string,Handler>>;
/** Concurrent, durable admission; SDK task guards retain prepare/stop/steer ordering.
 * Caller disconnect cannot cancel an accepted send or answer. Complete is acceptance, not generation completion.
 */
export async function dispatchTaskConversationRequest(input:JsonBusinessInput, request:ReturnType<typeof configurationRequest>, target:{route:string;params:Record<string,string>}):Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return {status:401,headers:{},body:{error:"Unauthorized"}};
  if ((input.body?.byteLength??0)>taskConversationBodyLimit(input.route)) return {status:413,headers:{},body:{error:"Request body is too large"}};
  const response = await commands.run({operationId:input.operationId,handler:async()=>{
    const id=target.params.id;
    if (!validTaskLifecycleId(id)) return Response.json({error:"Invalid task ID"},{status:400});
    const response=await handlers[target.route][input.method](request,{params:Promise.resolve({id})});
    const body=await response.json();
    if(response.status>=500) body.error="タスクの送信・応答結果を確認できません";
    return Response.json(body,{status:response.status});
  }});
  return {status:response.status,headers:{"cache-control":"no-store, private"},body:await response.json()};
}
