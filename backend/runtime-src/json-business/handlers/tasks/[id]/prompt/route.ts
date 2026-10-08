import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { handleTaskPrompt, type TaskPromptBody } from "@/lib/pi/task-prompt";
export async function POST(req:NextRequest, {params}:{params:Promise<{id:string}>}) {
  assertConfigurationOwner();
  const {id}=await params;
  const body=await req.json().catch(()=>null) as TaskPromptBody|null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({error:"prompt が必要です"},{status:400});
  const result=await handleTaskPrompt(id,body);
  return NextResponse.json(result.body,{status:result.status});
}
