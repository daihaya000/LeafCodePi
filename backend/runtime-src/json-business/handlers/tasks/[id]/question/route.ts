import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { respondToQuestionPrompt } from "../../../../../lib/task-conversation";
import { jsonError } from "@/lib/pi/harness";
function isValidAnswers(answers:unknown):answers is string[][] {
  return Array.isArray(answers)&&answers.every(row=>Array.isArray(row)&&row.every(v=>typeof v==="string"&&v.trim().length>0));
}
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}) {
  assertConfigurationOwner();
  try {
    const {id}=await params;
    const body=await req.json().catch(()=>null) as {requestId?:unknown;answers?:unknown;reject?:unknown}|null;
    const requestId=typeof body?.requestId==="string"?body.requestId.trim():"";
    if(!requestId) return NextResponse.json({error:"requestId is required"},{status:400});
    if(body?.reject!==undefined&&typeof body.reject!=="boolean") return NextResponse.json({error:"reject must be a boolean"},{status:400});
    let answer:{answers:string[][]}|null=null;
    if(!body?.reject) {
      if(!isValidAnswers(body?.answers)) return NextResponse.json({error:"answers（string[][]）が必要です"},{status:400});
      answer={answers:body.answers};
    }
    if(!respondToQuestionPrompt(id,requestId,answer)) return NextResponse.json({error:"question request not found"},{status:404});
    return NextResponse.json({ok:true});
  } catch(error) {
    const {error:message,status}=jsonError(error);
    return NextResponse.json({error:message},{status});
  }
}
