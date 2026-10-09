import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { roomConversationBodyLimit, publicRoomConversationBody } from "@shared/room-conversation-contract.mjs";
import { validBotLifecycleId } from "@shared/bot-lifecycle-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as prompt from "./handlers/bots/rooms/[id]/prompt/route";
import * as code from "./handlers/bots/rooms/[id]/code/route";
import * as revert from "./handlers/bots/rooms/[id]/revert/route";
const commands=createTaskConversationCommands({ledgerPath:()=>join(dataDir(),"room-conversation-command.json")});
/** Concurrent admission: Stop must not queue behind session/Goal preparation or tree editing. */
export async function dispatchRoomConversationRequest(input:JsonBusinessInput,request:ReturnType<typeof configurationRequest>,target:{route:string;params:Record<string,string>}):Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if(!input.authorized)return {status:401,headers:{},body:{error:"Unauthorized"}};
  if((input.body?.byteLength??0)>roomConversationBodyLimit(input.route))return {status:413,headers:{},body:{error:"Request body is too large"}};
  const response=await commands.run({operationId:input.operationId,handler:async()=>{
    if(!validBotLifecycleId(target.params.id))return Response.json({error:"Invalid Room ID"},{status:400});
    const context={params:Promise.resolve({id:target.params.id})},handler=target.route.endsWith("/prompt")?prompt.POST:target.route.endsWith("/code")?code.POST:revert.POST;
    const result=await handler(request,context),projected=publicRoomConversationBody(target.route,await result.json(),result.status);
    if(!projected)return Response.json({error:"Room会話の処理結果を確認できません"},{status:503});
    return Response.json(projected,{status:result.status});
  }});
  return {status:response.status,headers:{"cache-control":"no-store, private"},body:await response.json()};
}
