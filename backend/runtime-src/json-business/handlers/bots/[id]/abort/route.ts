import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readConversationBot, abortBotConversation } from "../../../../../lib/bot-conversation";
import { jsonError } from "@/lib/pi/harness";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function POST(_req: Request,{params}:{params:Promise<{id:string}>}) {
  assertConfigurationOwner();
  try {const {id}=await params;if(!readConversationBot(id))return Response.json({error:"Bot not found"},{status:404});
    const task=await abortBotConversation(id);if(!task)return Response.json({error:"タスクが見つかりません"},{status:404});return Response.json({task});
  }catch(error){const {error:message,status}=jsonError(error);return Response.json({error:status>=500?"Bot会話の処理結果を確認できません":message},{status});}
}
