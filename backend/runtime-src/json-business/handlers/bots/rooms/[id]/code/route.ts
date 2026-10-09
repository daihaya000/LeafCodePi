import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { abortRoomCodeRequest } from "../../../../../../lib/room-code";
import { jsonError } from "../../../../../../lib/pi/harness";
export const runtime="nodejs"; export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 assertConfigurationOwner();
 try{
  const id=(await params).id,body=await request.json().catch(()=>null) as {action?:unknown;requestId?:unknown}|null;
  if(body?.action!=="abort")return Response.json({error:"Unsupported action"},{status:400});
  if(body.requestId!==undefined&&(typeof body.requestId!=="string"||! /^[a-f0-9]{64}$/.test(body.requestId)))return Response.json({error:"invalid requestId"},{status:400});
  const result=await abortRoomCodeRequest(id,body.requestId as string|undefined);
  return Response.json(result.body,{status:result.status});
 }catch(error){const {error:message,status}=jsonError(error);return Response.json({error:status>=500?"Room会話の処理結果を確認できません":message},{status});}
}
