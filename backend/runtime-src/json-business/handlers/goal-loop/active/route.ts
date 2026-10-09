import { ConfigurationResponse } from "../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { activeGoalLoopTaskIds } from "../../../../lib/task-goal-loop";
export async function GET() {
  assertConfigurationOwner();
  try { const taskIds=activeGoalLoopTaskIds();return ConfigurationResponse.json({active:taskIds.length,taskIds}); }
  catch { return ConfigurationResponse.json({error:"BackendのGoal Loop状態を取得できません"},{status:503}); }
}
