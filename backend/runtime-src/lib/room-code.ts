import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getRoom } from "./rooms";
import { pendingRoomCodeRequestForRoom, roomCodeRequestForRoom, stopBotCodeRequest } from "./pi/bot-code-relay";
import { abortTaskIncludingColdGoalLoop, completeBotCodeRequest } from "./pi/harness";
/** Only the owner's active outbox record in this exact Room can select the Bot/Code task to stop. */
export async function abortRoomCodeRequest(roomId: string, requestedId?: string) {
 assertConfigurationOwner();
 if(!getRoom(roomId))throw Object.assign(new Error("Room not found"),{status:404});
 const request=requestedId===undefined?pendingRoomCodeRequestForRoom(roomId):roomCodeRequestForRoom(roomId,requestedId);
 if(!request)throw Object.assign(new Error("No running Code request"),{status:404});
 try{
  const stopped=await stopBotCodeRequest(request.botId,request.id);
  if(!stopped)return {status:409,body:{error:"Code request changed"}};
  if(stopped.codeTaskId){
   try {return {status:200,body:{task:await abortTaskIncludingColdGoalLoop(stopped.codeTaskId)}};}
   finally {await completeBotCodeRequest(request.id);}
  }
  return {status:200,body:{requestId:request.id,state:stopped.state}};
 }catch{throw Object.assign(new Error("Room会話の処理結果を確認できません"),{status:503});}
}
