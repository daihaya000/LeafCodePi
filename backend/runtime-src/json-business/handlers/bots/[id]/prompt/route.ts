import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readConversationBot, promptBotConversation, startBotConversationGoal } from "../../../../../lib/bot-conversation";
import { isPromptFileList, isPromptFileText, isPromptFileWithinSize, isPromptImageList, isPromptImageWithinSize, isPromptTextWithinSize, MAX_PROMPT_ATTACHMENTS } from "@/lib/prompt-images";
import { jsonError } from "@/lib/pi/harness";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function POST(req: Request,{params}:{params:Promise<{id:string}>}) {
  assertConfigurationOwner();
  try {
    const {id}=await params;if(!readConversationBot(id))return Response.json({error:"Bot not found"},{status:404});
    const body=await req.json().catch(()=>null) as {prompt?:unknown;images?:unknown;files?:unknown;goalLoop?:unknown}|null;
    if(typeof body?.prompt!=="string")return Response.json({error:"Prompt is required"},{status:400});
    if(!isPromptTextWithinSize(body.prompt))return Response.json({error:"本文プロンプトが長すぎます"},{status:413});
    if(body.images!==undefined&&(!isPromptImageList(body.images)||body.images.some(image=>!isPromptImageWithinSize(image))))return Response.json({error:"invalid images"},{status:400});
    if(body.files!==undefined&&(!isPromptFileList(body.files)||body.files.some(file=>!isPromptFileWithinSize(file)||!isPromptFileText(file))))return Response.json({error:"invalid files: UTF-8 text only"},{status:400});
    if((body.images?.length??0)+(body.files?.length??0)>MAX_PROMPT_ATTACHMENTS)return Response.json({error:`添付は${MAX_PROMPT_ATTACHMENTS}件までです`},{status:400});
    if(!body.prompt.trim()&&!body.images?.length&&!body.files?.length)return Response.json({error:"Prompt is required"},{status:400});
    if(body.goalLoop!==undefined){
      if(body.files?.length)return Response.json({error:"Goal loop の開始では画像のみ添付できます"},{status:400});
      if(body.goalLoop===null||typeof body.goalLoop!=="object"||Array.isArray(body.goalLoop))return Response.json({error:"invalid goalLoop"},{status:400});
      const loop=body.goalLoop as Record<string,unknown>;
      const result=await startBotConversationGoal(id,{goal:body.prompt,acceptance:loop.acceptance,maxTurns:loop.maxTurns,cooldownSeconds:loop.cooldownSeconds,forceFullRun:loop.forceFullRun,images:body.images});
      return Response.json({task:null,loop:result.loop});
    }
    return Response.json({task:await promptBotConversation(id,body.prompt,body.images,body.files)});
  }catch(error){const {error:message,status}=jsonError(error);return Response.json({error:status>=500?"Bot会話の処理結果を確認できません":message},{status});}
}
