import { type ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { startGoalLoopWithSelection, type GoalLoopStartBody } from "@/lib/pi/goal-loop-start";
import { isGoalLoopCommandApplied } from "@/lib/pi/goal-loop-command";
import { botIdForCodeTask } from "@/lib/pi/bot-code-relay";
import { goalLoopCommand, goalLoopState } from "../../../../../lib/task-goal-loop";
import { stopBotCodeTask } from "../../../../../lib/task-lifecycle";
import { jsonError } from "@/lib/pi/harness";
import { clampGoalLoopMaxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS } from "@/lib/goal-loop-settings";
type Params={params:Promise<{id:string}>};
type Body=GoalLoopStartBody&{action?:unknown};
export async function GET(_req:NextRequest,{params}:Params) {
  assertConfigurationOwner();
  try { const {id}=await params;return NextResponse.json({loop:await goalLoopState(id,{offline:true})}); }
  catch(error){const {error:message,status}=jsonError(error);return NextResponse.json({error:message},{status});}
}
export async function POST(req:NextRequest,{params}:Params) {
  assertConfigurationOwner();
  try {
    const {id}=await params,body=await req.json().catch(()=>null) as Body|null;
    if(body?.action!=="start")return NextResponse.json({error:"POST の action は start です"},{status:400});
    return NextResponse.json(await startGoalLoopWithSelection(id,body));
  } catch(error){const {error:message,status}=jsonError(error);return NextResponse.json({error:message},{status});}
}
export async function PATCH(req:NextRequest,{params}:Params) {
  assertConfigurationOwner();
  try {
    const {id}=await params,body=await req.json().catch(()=>null) as Body|null,action=body?.action;
    if(action!=="pause"&&action!=="resume"&&action!=="stop"&&action!=="complete")return NextResponse.json({error:"action は pause/resume/stop/complete のいずれかです"},{status:400});
    // Resolve delegated Code supervision in the owner, never trust a caller-supplied Bot ID.
    const botId=action==="stop"?botIdForCodeTask(id):undefined;
    let loop;
    if(botId){await stopBotCodeTask(botId,id);loop=await goalLoopState(id,{offline:true});}
    else loop=await goalLoopCommand(id,{action,maxTurns:action==="resume"&&body?.maxTurns!==undefined?clampGoalLoopMaxTurns(body.maxTurns,DEFAULT_GOAL_LOOP_MAX_TURNS):undefined});
    if(!isGoalLoopCommandApplied(action,loop))return NextResponse.json({error:action==="resume"?"Goal Loop を再開できませんでした":"Goal Loop の操作が反映されませんでした"},{status:409});
    return NextResponse.json({loop});
  } catch(error){const {error:message,status}=jsonError(error);return NextResponse.json({error:message},{status});}
}
