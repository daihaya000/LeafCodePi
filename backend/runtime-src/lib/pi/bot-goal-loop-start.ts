import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { botTaskId, getBot } from "@/lib/bots";
import { goalLoopCommand, isTaskRuntimeBusyForGoalLoopStart } from "@/lib/pi/harness";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";
import { isGoalLoopLiveStatus } from "@/lib/pi/goal-loop-state";
import { isPromptImageList, isPromptImageWithinSize, isPromptTextWithinSize } from "@/lib/prompt-images";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
  normalizeGoalLoopAcceptance,
} from "@/lib/goal-loop-settings";

export type BotGoalLoopStartBody = {
  goal?: unknown;
  acceptance?: unknown;
  maxTurns?: unknown;
  cooldownSeconds?: unknown;
  forceFullRun?: unknown;
  images?: unknown;
};

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

/** Unlike ordinary tasks, a Bot task may not exist until goalLoopCommand initializes it. */
export async function startBotGoalLoop(botId: string, body: BotGoalLoopStartBody) {
  assertConfigurationOwner();
  assertLocalRuntimeAllowed();
  if (!getBot(botId)) fail("Bot not found", 404);
  if (typeof body.goal !== "string") fail("Prompt is required", 400);
  if (!isPromptTextWithinSize(body.goal)) fail("本文プロンプトが長すぎます", 413);
  if (body.images !== undefined && (!isPromptImageList(body.images) || body.images.some((image) => !isPromptImageWithinSize(image)))) {
    fail("invalid images", 400);
  }
  if (!body.goal.trim() && !body.images?.length) fail("Prompt is required", 400);
  const acceptance = normalizeGoalLoopAcceptance(body.acceptance);
  const validNumber = (value: unknown) => value === undefined || typeof value === "number" || typeof value === "string";
  if (acceptance === null || !validNumber(body.maxTurns) || !validNumber(body.cooldownSeconds) || (body.forceFullRun !== undefined && typeof body.forceFullRun !== "boolean")) {
    fail("invalid goalLoop", 400);
  }
  const id = botTaskId(botId);
  if (isTaskRuntimeBusyForGoalLoopStart(id)) fail("タスクが実行中のため Goal Loop を開始できません", 409);
  const loop = await goalLoopCommand(id, {
    action: "start",
    goal: body.goal,
    acceptance,
    maxTurns: clampGoalLoopMaxTurns(body.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
    cooldownSeconds: clampGoalLoopCooldownSeconds(body.cooldownSeconds),
    forceFullRun: body.forceFullRun === true,
    images: body.images,
  });
  if (!loop || !isGoalLoopLiveStatus(loop.status)) fail("Goal Loop を開始できませんでした", 409);
  return { loop, agent: null };
}
