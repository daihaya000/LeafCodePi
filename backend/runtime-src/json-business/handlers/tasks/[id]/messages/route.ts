import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { InvalidTaskMessageCursorError, pageTaskMessages } from "@shared/task-history.mjs";
import { stripImageDataFromMessages } from "@shared/task-history-content.mjs";
import { readTaskTranscript } from "@/lib/task-transcript";
import { readHistoryPageSize } from "../../../../../lib/pi/history-page-size";
import { jsonError } from "@/lib/pi/harness";
export async function GET(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 assertConfigurationOwner();
 try{
  const {id}=await params,before=req.nextUrl.searchParams.get("before");
  if(before!==null&&(before.trim().length===0||before.length>512))return NextResponse.json({error:"履歴カーソルが不正です"},{status:400});
  const transcript=await readTaskTranscript(id);if(!transcript.ok)return NextResponse.json(transcript.body,{status:transcript.status});
  const page=pageTaskMessages(transcript.messages,before,readHistoryPageSize());
  return NextResponse.json(before===null?page:{...page,messages:stripImageDataFromMessages(page.messages)});
 }catch(error){if(error instanceof InvalidTaskMessageCursorError)return NextResponse.json({error:error.message},{status:409});const {error:message,status}=jsonError(error);return NextResponse.json({error:message},{status});}
}
