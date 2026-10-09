import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { botTaskId, getBot } from "./bots";
import * as owner from "./pi/harness";
import { startBotGoalLoop, type BotGoalLoopStartBody } from "./pi/bot-goal-loop-start";
import { cancelBotCodeRequests } from "./pi/bot-code-relay";
import type { PromptFileInput, PromptImageInput } from "./prompt-images";
export function readConversationBot(id: string) { assertConfigurationOwner(); return getBot(id); }
export function promptBotConversation(id: string, prompt: string, images?: PromptImageInput[], files?: PromptFileInput[]) {
  assertConfigurationOwner();
  const taskId=botTaskId(id);
  return files===undefined ? images===undefined ? owner.promptTask(taskId,prompt) : owner.promptTask(taskId,prompt,images) : owner.promptTask(taskId,prompt,images,{files});
}
export function startBotConversationGoal(id: string, body: BotGoalLoopStartBody) { assertConfigurationOwner(); return startBotGoalLoop(id,body); }
/** Preserve the shipped Backend Bot-owned stop: mark matching outbox before cold/live Goal abort. */
export function abortBotConversation(id: string) { assertConfigurationOwner(); return owner.stopBotCodeTask(id,botTaskId(id)); }
export async function revertBotConversation(id: string, entryId: string) {
  assertConfigurationOwner();
  const result=await owner.revertTask(botTaskId(id),entryId);
  // Only 1:1-origin requests, never the Bot's separate Room conversation.
  try {
    const cancelledCodeRequests=await cancelBotCodeRequests(id);
    return {...result,cancelledCodeRequests};
  } catch {
    // The SDK tree edit already succeeded. Even a typed refusal now is partial/unknown, never a safe retry.
    throw Object.assign(new Error("Bot会話の処理結果を確認できません"), { status: 503 });
  }
}
