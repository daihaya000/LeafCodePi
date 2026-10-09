import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import * as owner from "./pi/harness";
import { stopBotCodeRequest } from "./pi/bot-code-relay";
export const getBotCodeSessionPanelState: typeof owner.getBotCodeSessionPanelState = (...args) => { assertConfigurationOwner(); return owner.getBotCodeSessionPanelState(...args); };
export const createBotCodeTask: typeof owner.createBotCodeTask = (...args) => { assertConfigurationOwner(); return owner.createBotCodeTask(...args); };
export const continueBotCodeTask: typeof owner.continueBotCodeTask = (...args) => { assertConfigurationOwner(); return owner.continueBotCodeTask(...args); };
export const stopBotCodeTask: typeof owner.stopBotCodeTask = (...args) => { assertConfigurationOwner(); return owner.stopBotCodeTask(...args); };
export const abortTaskIncludingColdGoalLoop: typeof owner.abortTaskIncludingColdGoalLoop = (...args) => { assertConfigurationOwner(); return owner.abortTaskIncludingColdGoalLoop(...args); };
export const goalLoopCommand: typeof owner.goalLoopCommand = (...args) => { assertConfigurationOwner(); return owner.goalLoopCommand(...args); };
export const peekCodeRequestProgress: typeof owner.peekCodeRequestProgress = (...args) => { assertConfigurationOwner(); return owner.peekCodeRequestProgress(...args); };
export async function abortBotCodeRequest(botId: string, requestId: string) {
 assertConfigurationOwner();
 const stopped=await stopBotCodeRequest(botId,requestId);
 if(!stopped)throw Object.assign(new Error("実行中のCode依頼がありません"),{status:404});
 try {
  let task;
  try { if(stopped.codeTaskId)task=await owner.abortTaskIncludingColdGoalLoop(stopped.codeTaskId); }
  finally { if(stopped.codeTaskId)await owner.completeBotCodeRequest(requestId); }
  return {requestId,state:stopped.state,...(task?{task}:{})};
 } catch { throw Object.assign(new Error("Bot Codeの処理結果を確認できません"),{status:503}); }
}
