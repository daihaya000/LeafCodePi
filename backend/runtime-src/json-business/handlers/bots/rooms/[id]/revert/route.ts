import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { revertRoomComposer } from "../../../../../../lib/room-revert";
import { jsonError } from "../../../../../../lib/pi/harness";
export const runtime="nodejs"; export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 assertConfigurationOwner();
 try{
  const id=(await params).id,body=await request.json().catch(()=>null) as {messageId?:unknown}|null;
  const messageId=typeof body?.messageId==="string"?body.messageId.trim():"";
  if(!messageId)return Response.json({error:"messageId が指定されていません"},{status:400});
  if(messageId.length>256||/[\x00-\x1f\x7f]/.test(messageId))return Response.json({error:"Invalid message ID"},{status:400});
  return Response.json(await revertRoomComposer(id,messageId));
 }catch(error){const {error:message,status}=jsonError(error);return Response.json({error:status>=500?"Room会話の処理結果を確認できません":message},{status});}
}
