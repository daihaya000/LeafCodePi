import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readConversationBot, revertBotConversation } from "../../../../../lib/bot-conversation";
import { jsonError } from "@/lib/pi/harness";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function POST(req: Request,{params}:{params:Promise<{id:string}>}) {
  assertConfigurationOwner();
  try {const {id}=await params;if(!readConversationBot(id))return Response.json({error:"Bot not found"},{status:404});
    const body=await req.json().catch(()=>null) as {entryId?:unknown}|null;
    const entryId=typeof body?.entryId==="string"?body.entryId.trim():"";
    if(!entryId)return Response.json({error:"entryId が指定されていません"},{status:400});
    if(entryId.length>256||/[\x00-\x1f\x7f]/.test(entryId))return Response.json({error:"Invalid entry ID"},{status:400});
    return Response.json(await revertBotConversation(id,entryId));
  }catch(error){const {error:message,status}=jsonError(error);return Response.json({error:status>=500?"Bot会話の処理結果を確認できません":message},{status});}
}
