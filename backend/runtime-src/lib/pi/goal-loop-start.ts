import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getTask } from "@/lib/store";
import { readSessionConversation } from "@/lib/direct-session";
import { parseDirectModelKey } from "@/lib/direct-generation";
import { resolveAutoAgent } from "@/lib/auto-agent";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import { isGoalLoopLiveStatus } from "@/lib/pi/goal-loop-state";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";
import { beginTaskPreparation, hasTaskPreparation } from "./task-operation-guard";
import {
  goalLoopCommand,
  isTaskRuntimeBusyForGoalLoopStart,
  resolveAutoModel,
  setTaskAgent,
  setTaskModel,
  setTaskThinkingLevel,
  validateTaskModelSelection,
} from "@/lib/pi/harness";
import {
  autoModelValue,
  autoVariantToThinkingLevel,
  DEFAULT_AUTO_OPTIMIZE_MODE,
  isAutoOptimizeMode,
  normalizeAutoRouteConfig,
  type AutoDecision,
} from "@/lib/auto-model";
import { isPromptImageList, isPromptImageWithinSize } from "@/lib/prompt-images";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
  MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS,
  MAX_GOAL_LOOP_ACCEPTANCE_ITEMS,
} from "@/lib/goal-loop-settings";

export type GoalLoopStartBody = {
  goal?: string;
  acceptance?: unknown;
  maxTurns?: unknown;
  cooldownSeconds?: unknown;
  forceFullRun?: unknown;
  model?: string;
  thinkingLevel?: string;
  auto?: unknown;
  autoOptimize?: unknown;
  autoRouteOverrides?: unknown;
  agent?: string;
  images?: unknown;
};

// Pasted acceptance sections may include a heading and blank lines. Bound the raw input
// before splitting, then apply the item limit to actual non-empty criteria.
const MAX_GOAL_LOOP_ACCEPTANCE_INPUT_CHARS =
  MAX_GOAL_LOOP_ACCEPTANCE_ITEMS * MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS + 1_024;
const MAX_GOAL_LOOP_ACCEPTANCE_INPUT_ARRAY_ENTRIES = MAX_GOAL_LOOP_ACCEPTANCE_ITEMS * 3 + 1;
const GOAL_LOOP_ACCEPTANCE_HEADING = /^(?:承認条件|acceptance criteria)\s*[:：]?$/i;

export function normalizeGoalLoopStartAcceptance(value: unknown): string[] | null {
  if (value === undefined || value === null || value === "") return [];
  let values: unknown[];
  if (Array.isArray(value)) {
    if (value.length > MAX_GOAL_LOOP_ACCEPTANCE_INPUT_ARRAY_ENTRIES) return null;
    values = value;
  } else if (typeof value === "string") {
    if (value.length > MAX_GOAL_LOOP_ACCEPTANCE_INPUT_CHARS) return null;
    values = value.split(/\r\n?|\n/);
  } else {
    return null;
  }

  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text || GOAL_LOOP_ACCEPTANCE_HEADING.test(text)) continue;
    if (text.length > MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS) return null;
    result.push(text);
    if (result.length > MAX_GOAL_LOOP_ACCEPTANCE_ITEMS) return null;
  }
  return result;
}

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

/** Owner-only operation, independent of Next's request/response objects. */
export async function startGoalLoopWithSelection(id: string, body: GoalLoopStartBody) {
  assertConfigurationOwner();
  assertLocalRuntimeAllowed();
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid Goal Loop request", 400);
  if (hasTaskPreparation(id)) fail("タスクの送信準備中です", 409);
  const preparation = beginTaskPreparation(id);
  try {
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) fail("goal は必須です", 400);
  if (goal.length > 4_000) fail("goal は4000文字以内で指定してください", 400);
  const criteria = normalizeGoalLoopStartAcceptance(body.acceptance);
  if (!criteria) {
    fail(
      `acceptance は最大${MAX_GOAL_LOOP_ACCEPTANCE_ITEMS}項目まで、各項目${MAX_GOAL_LOOP_ACCEPTANCE_ITEM_CHARS}文字以内で指定してください`,
      400,
    );
  }
  if (body.images !== undefined && (!isPromptImageList(body.images) || body.images.some((image) => !isPromptImageWithinSize(image)))) {
    fail("invalid images", 400);
  }
  if (body.agent !== undefined && typeof body.agent !== "string") fail("invalid agent", 400);
  if (body.model !== undefined && typeof body.model !== "string") fail("invalid model", 400);
  if (body.auto !== undefined && typeof body.auto !== "boolean") fail("invalid auto", 400);
  if (body.autoOptimize !== undefined && !isAutoOptimizeMode(body.autoOptimize)) {
    fail("invalid autoOptimize", 400);
  }
  if ((body.autoOptimize !== undefined || body.autoRouteOverrides !== undefined) && body.auto !== true) {
    fail("Auto設定にはautoが必要です", 400);
  }
  const currentTask = getTask(id);
  if (!currentTask) fail("タスクが見つかりません", 404);
  if (currentTask.status !== "working" && body.model && body.auto !== true) {
    await preparation.waitFor(validateTaskModelSelection(body.model));
  }
  let model = body.model;
  let thinkingLevel = body.thinkingLevel;
  let autoDecision: AutoDecision | undefined;
  if (body.auto === true && currentTask.status !== "working") {
    autoDecision =
      (await preparation.waitFor(resolveAutoModel({
        prompt: goal,
        hasImages: Boolean(body.images?.length),
        historyMessageCount: readSessionConversation(currentTask.sessionFile).length,
        recentFailure: currentTask.status === "error" || Boolean(currentTask.error),
        mode: isAutoOptimizeMode(body.autoOptimize) ? body.autoOptimize : DEFAULT_AUTO_OPTIMIZE_MODE,
        config: body.autoRouteOverrides === undefined ? undefined : normalizeAutoRouteConfig(body.autoRouteOverrides),
      }))) ?? undefined;
    if (!autoDecision) fail("Auto で選択可能なモデルがありません", 400);
    model = autoModelValue(autoDecision);
    thinkingLevel = autoVariantToThinkingLevel(autoDecision.variant);
  } else if (currentTask.status === "working") {
    model = undefined;
    thinkingLevel = undefined;
  }
  preparation.assertCurrent();
  let agent = body.agent?.trim() || undefined;
  const autoAgentRequested = agent === AUTO_AGENT_VALUE;
  if (agent === AUTO_AGENT_VALUE) {
    if (currentTask.status === "working") {
      agent = currentTask.agent?.trim() || undefined;
    } else {
      const taskModel = currentTask.providerID && currentTask.modelID
        ? {
            providerID: currentTask.providerID,
            modelID: currentTask.modelID,
            ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
          }
        : undefined;
      const requestedModel = parseDirectModelKey(model) ?? taskModel;
      agent = await preparation.waitFor(resolveAutoAgent({
        conversation: readSessionConversation(currentTask.sessionFile),
        prompt: goal,
        ...(requestedModel ? { requestedModel } : {}),
        ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
        ...(currentTask.accountIdExplicit ? { accountIdExplicit: true } : {}),
      }));
    }
  }
  preparation.assertCurrent();
  const nextAgent = agent && agent !== (currentTask.agent?.trim() || undefined) ? agent : undefined;
  if (isTaskRuntimeBusyForGoalLoopStart(id)) {
    fail("タスクが実行中のため Goal Loop を開始できません", 409);
  }
  const previousAgent = currentTask.agent?.trim() || undefined;
  const previousModel = currentTask.providerID && currentTask.modelID
    ? autoModelValue({
        providerID: currentTask.providerID,
        modelID: currentTask.modelID,
        ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
      })
    : undefined;
  const previousThinking = currentTask.thinkingLevel;
  const previousAccountExplicit = currentTask.accountIdExplicit === true;
  const changedAgent = Boolean(nextAgent);
  const changedModel = Boolean(model);
  const changedThinking = Boolean(thinkingLevel);
  try {
    if (nextAgent) await setTaskAgent(id, nextAgent);
    preparation.assertCurrent();
    if (model) {
      await setTaskModel(id, model, body.auto === true ? { accountIdExplicit: false } : undefined);
    }
    preparation.assertCurrent();
    if (thinkingLevel) await setTaskThinkingLevel(id, thinkingLevel);
    preparation.assertCurrent();
    const loop = await goalLoopCommand(id, {
      action: "start",
      goal,
      acceptance: criteria,
      maxTurns: clampGoalLoopMaxTurns(body.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
      cooldownSeconds: clampGoalLoopCooldownSeconds(body.cooldownSeconds),
      forceFullRun: body.forceFullRun === true,
      autoAgent: autoAgentRequested,
      images: body.images,
    });
    // A stale epoch can return a non-live loop without throwing; still roll back the selection.
    if (!loop || !isGoalLoopLiveStatus(loop.status)) fail("Goal Loop を開始できませんでした", 409);
    return {
      loop,
      agent: getTask(id)?.agent ?? null,
      ...(autoDecision ? { autoDecision } : {}),
    };
  } catch (error) {
    try {
      // A cancelled request must not overwrite a newer request's settings.
      if (!preparation.isCurrent()) throw error;
      if (changedAgent && previousAgent !== (getTask(id)?.agent?.trim() || undefined)) {
        await setTaskAgent(id, previousAgent ?? "");
      }
      if (changedModel && previousModel) {
        await setTaskModel(id, previousModel, { accountIdExplicit: previousAccountExplicit });
      }
      if (changedThinking && previousThinking) await setTaskThinkingLevel(id, previousThinking);
    } catch {
      // best-effort rollback
    }
    throw error;
  }
  } finally { preparation.release(); }
}
