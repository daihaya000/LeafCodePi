import { getTask } from "@/lib/store";
import { readSessionConversation } from "@/lib/direct-session";
import { parseDirectModelKey } from "@/lib/direct-generation";
import { autoAgentHasOwnModel, resolveAutoAgent } from "@/lib/auto-agent";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import { autoModelValue, autoVariantToThinkingLevel, DEFAULT_AUTO_OPTIMIZE_MODE, isAutoOptimizeMode, normalizeAutoRouteConfig, type AutoDecision } from "@/lib/auto-model";
import { isRecoverableResumeSelectionError, jsonError, promptTask, resolveAutoModel, validateTaskModelSelection } from "@/lib/pi/harness";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";
import { isPromptFileList, isPromptFileText, isPromptFileWithinSize, isPromptImageList, isPromptImageWithinSize, isPromptTextWithinSize, MAX_PROMPT_ATTACHMENTS, type PromptFileInput } from "@/lib/prompt-images";
import type { ThinkingLevel } from "@/lib/types";
import { beginTaskPreparation } from "./task-operation-guard";

export type TaskPromptBody = {
  prompt?: string;
  images?: { mimeType: string; data: string }[];
  files?: PromptFileInput[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  auto?: unknown; autoRetry?: unknown; autoOptimize?: unknown; autoRouteOverrides?: unknown;
  agent?: string;
  streamingBehavior?: "steer" | "followUp";
  resume?: boolean;
};
export type TaskPromptResult = {
  status: number;
  body: { task?: Awaited<ReturnType<typeof promptTask>>; autoDecision?: AutoDecision; error?: string };
};

/** Shared owning-mode ladder: Backend and standalone development use identical selection/recovery. */
export async function handleTaskPrompt(id: string, body: TaskPromptBody): Promise<TaskPromptResult> {
  try {
    assertLocalRuntimeAllowed();
    if (!body || typeof body !== "object" || Array.isArray(body)
      || (body.prompt !== undefined && typeof body.prompt !== "string")
      || (body.model !== undefined && typeof body.model !== "string")
      || (body.agent !== undefined && typeof body.agent !== "string")
      || (body.resume !== undefined && typeof body.resume !== "boolean")
      || (body.streamingBehavior !== undefined && !["steer", "followUp"].includes(body.streamingBehavior))
      || (body.auto !== undefined && typeof body.auto !== "boolean")
      || (body.autoRetry !== undefined && typeof body.autoRetry !== "boolean")
      || (body.autoOptimize !== undefined && !isAutoOptimizeMode(body.autoOptimize))
      || ((body.autoRetry === true || body.autoOptimize !== undefined || body.autoRouteOverrides !== undefined) && body.auto !== true)) {
      return { status: 400, body: { error: "Auto設定またはプロンプトが不正です" } };
    }
    if (body.images !== undefined && (!isPromptImageList(body.images) || body.images.some((image) => !isPromptImageWithinSize(image)))) return { status: 400, body: { error: "invalid images" } };
    if (body.files !== undefined && (!isPromptFileList(body.files) || body.files.some((file) => !isPromptFileWithinSize(file) || !isPromptFileText(file)))) return { status: 400, body: { error: "invalid files" } };
    if ((body.images?.length ?? 0) + (body.files?.length ?? 0) > MAX_PROMPT_ATTACHMENTS) return { status: 400, body: { error: "添付が多すぎます" } };
    if (typeof body.prompt === "string" && !isPromptTextWithinSize(body.prompt)) return { status: 413, body: { error: "本文プロンプトが長すぎます" } };
    if (!body.prompt?.trim() && !body.images?.length && !body.files?.length) return { status: 400, body: { error: "prompt が必要です" } };
    const preparation = beginTaskPreparation(id);
    try {
    const currentTask = getTask(id);
    if (!currentTask) return { status: 404, body: { error: "タスクが見つかりません" } };
    const canSwitchRoute = currentTask.status !== "working" && body.streamingBehavior === undefined;
    if (canSwitchRoute && body.model && (body.auto !== true || body.autoRetry === true)) {
      try { await preparation.waitFor(validateTaskModelSelection(body.model)); }
      catch (error) { if (body.resume !== true || !isRecoverableResumeSelectionError(error)) throw error; }
    }
    const parallelAgent = body.agent?.trim() === AUTO_AGENT_VALUE && body.auto === true && canSwitchRoute && body.autoRetry !== true && autoAgentHasOwnModel()
      ? resolveAutoAgent({ conversation: readSessionConversation(currentTask.sessionFile), prompt: body.prompt ?? "", hasImages: Boolean(body.images?.length),
          ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}), ...(currentTask.accountIdExplicit ? { accountIdExplicit: true } : {}) })
      : undefined;
    parallelAgent?.catch(() => {});
    let model = body.model;
    let thinkingLevel = body.thinkingLevel;
    let autoDecision: AutoDecision | undefined;
    if (body.auto === true && canSwitchRoute && body.autoRetry !== true) {
      autoDecision = (await preparation.waitFor(resolveAutoModel({
        prompt: body.prompt ?? "", hasImages: Boolean(body.images?.length), attachmentCount: (body.images?.length ?? 0) + (body.files?.length ?? 0),
        historyMessageCount: readSessionConversation(currentTask.sessionFile).length,
        recentFailure: currentTask.status === "error" || Boolean(currentTask.error),
        mode: isAutoOptimizeMode(body.autoOptimize) ? body.autoOptimize : DEFAULT_AUTO_OPTIMIZE_MODE,
        config: body.autoRouteOverrides === undefined ? undefined : normalizeAutoRouteConfig(body.autoRouteOverrides),
      }))) ?? undefined;
      if (!autoDecision) return { status: 400, body: { error: "Auto で選択可能なモデルがありません" } };
      model = autoModelValue(autoDecision);
      thinkingLevel = autoVariantToThinkingLevel(autoDecision.variant);
    } else if (!canSwitchRoute) { model = undefined; thinkingLevel = undefined; }
    preparation.assertCurrent();
    let agent = body.agent;
    if (agent?.trim() === AUTO_AGENT_VALUE) {
      if (currentTask.status === "working") agent = currentTask.agent?.trim() || undefined;
      else {
        const taskModel = currentTask.providerID && currentTask.modelID
          ? { providerID: currentTask.providerID, modelID: currentTask.modelID, ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}) } : undefined;
        const requestedModel = parseDirectModelKey(model) ?? taskModel;
        agent = await preparation.waitFor(parallelAgent ?? resolveAutoAgent({
          conversation: readSessionConversation(currentTask.sessionFile), prompt: body.prompt ?? "", hasImages: Boolean(body.images?.length),
          ...(requestedModel ? { requestedModel } : {}), ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
          ...(currentTask.accountIdExplicit ? { accountIdExplicit: true } : {}),
        }));
      }
    }
    preparation.assertCurrent();
    const task = await promptTask(id, body.prompt ?? "", body.images, {
      files: body.files, model, thinkingLevel, ...(body.auto === true ? { accountIdExplicit: false } : {}), agent,
      streamingBehavior: body.streamingBehavior, ...(body.resume === true ? { resume: true } : {}),
    });
    return { status: 200, body: { task, ...(autoDecision ? { autoDecision } : {}) } };
    } finally { preparation.release(); }
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return { status, body: { error: message } };
  }
}
