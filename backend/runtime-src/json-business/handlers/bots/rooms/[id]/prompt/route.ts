import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { handleRoomPrompt, type RoomPromptBody } from "../../../../../../lib/room-prompt";
export const runtime="nodejs"; export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 assertConfigurationOwner();
 const parsed=await request.json().catch(()=>null);
 const body=parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed as RoomPromptBody:null;
 // The admitted mutation is independent of a subscriber's disconnect.
 const result=await handleRoomPrompt((await params).id,body);
 return Response.json(result.body,{status:result.status});
}
