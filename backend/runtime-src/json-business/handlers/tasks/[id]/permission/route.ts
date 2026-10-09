import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { respondToPermissionPrompt } from "../../../../../lib/task-conversation";
import { jsonError } from "@/lib/pi/harness";
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}) {
  assertConfigurationOwner();
  try {
    const {id}=await params;
    const body=await req.json().catch(()=>null) as {requestId?:unknown;approved?:unknown}|null;
    const requestId=typeof body?.requestId==="string"?body.requestId.trim():"";
    if(!requestId) return NextResponse.json({error:"requestId is required"},{status:400});
    if(typeof body?.approved!=="boolean") return NextResponse.json({error:"approved must be a boolean"},{status:400});
    if(!respondToPermissionPrompt(id,requestId,body.approved)) return NextResponse.json({error:"permission request not found"},{status:404});
    return NextResponse.json({ok:true});
  } catch(error) {
    const {error:message,status}=jsonError(error);
    return NextResponse.json({error:message},{status});
  }
}
