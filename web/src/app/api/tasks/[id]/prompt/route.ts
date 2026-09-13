import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { readSessionConversation } from "@/lib/direct-session";
import { parseDirectModelKey } from "@/lib/direct-generation";
import {
  isPromptFileList,
  isPromptFileText,
  isPromptFileWithinSize,
  isPromptImageList,
  isPromptImageWithinSize,
  MAX_PROMPT_ATTACHMENTS,
  type PromptFileInput,
} from "@/lib/prompt-images";
import { autoAgentHasOwnModel, resolveAutoAgent } from "@/lib/auto-agent";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import {
  isRecoverableResumeSelectionError,
  jsonError,
  promptTask,
  resolveAutoModel,
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
import type { ThinkingLevel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      prompt?: string;
      images?: { mimeType: string; data: string }[];
      files?: PromptFileInput[];
      model?: string;
      thinkingLevel?: ThinkingLevel;
      auto?: unknown;
      autoRetry?: unknown;
      autoOptimize?: unknown;
      autoRouteOverrides?: unknown;
      agent?: string;
      subagentPermission?: "allow" | "deny";
      permissionMode?: unknown;
      skillPermission?: "allow" | "deny";
      streamingBehavior?: "steer" | "followUp";
      resume?: boolean;
    } | null;
    if (!body?.prompt?.trim() && !body?.images?.length && !body?.files?.length) {
      return NextResponse.json({ error: "prompt が必要です" }, { status: 400 });
    }
    if (body?.images !== undefined && (!isPromptImageList(body.images) || body.images.some((image) => !isPromptImageWithinSize(image)))) {
      return NextResponse.json({ error: "invalid images" }, { status: 400 });
    }
    if (body?.files !== undefined && (!isPromptFileList(body.files) || body.files.some((file) => !isPromptFileWithinSize(file) || !isPromptFileText(file)))) {
      return NextResponse.json({ error: "invalid files: UTF-8 text only" }, { status: 400 });
    }
    if ((body?.images?.length ?? 0) + (body?.files?.length ?? 0) > MAX_PROMPT_ATTACHMENTS) {
      return NextResponse.json({ error: `添付は${MAX_PROMPT_ATTACHMENTS}件までです` }, { status: 400 });
    }
    if (body?.agent !== undefined && typeof body.agent !== "string") {
      return NextResponse.json({ error: "invalid agent" }, { status: 400 });
    }
    if (body?.model !== undefined && typeof body.model !== "string") {
      return NextResponse.json({ error: "invalid model" }, { status: 400 });
    }
    const permissionMode = body?.permissionMode;
    if (
      permissionMode !== undefined &&
      permissionMode !== "allow" &&
      permissionMode !== "ask" &&
      permissionMode !== "deny"
    ) {
      return NextResponse.json({ error: "invalid permissionMode" }, { status: 400 });
    }
    if (body?.auto !== undefined && typeof body.auto !== "boolean") {
      return NextResponse.json({ error: "invalid auto" }, { status: 400 });
    }
    if (body?.autoRetry !== undefined && typeof body.autoRetry !== "boolean") {
      return NextResponse.json({ error: "invalid autoRetry" }, { status: 400 });
    }
    if (body?.resume !== undefined && typeof body.resume !== "boolean") {
      return NextResponse.json({ error: "invalid resume" }, { status: 400 });
    }
    if (body?.autoOptimize !== undefined && !isAutoOptimizeMode(body.autoOptimize)) {
      return NextResponse.json({ error: "invalid autoOptimize" }, { status: 400 });
    }
    if (
      (body?.autoRetry === true ||
        body?.autoOptimize !== undefined ||
        body?.autoRouteOverrides !== undefined) &&
      body?.auto !== true
    ) {
      return NextResponse.json({ error: "Auto設定にはautoが必要です" }, { status: 400 });
    }
    if (
      body?.streamingBehavior !== undefined &&
      !["steer", "followUp"].includes(body.streamingBehavior)
    ) {
      return NextResponse.json({ error: "無効な送信方式です" }, { status: 400 });
    }
    const currentTask = getTask(id);
    if (!currentTask) {
      return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
    }
    const canSwitchRoute =
      currentTask.status !== "working" && body?.streamingBehavior === undefined;
    if (
      canSwitchRoute &&
      body.model &&
      (body.auto !== true || body.autoRetry === true)
    ) {
      try {
        await validateTaskModelSelection(body.model);
      } catch (error) {
        if (
          body.resume !== true ||
          !isRecoverableResumeSelectionError(error)
        ) {
          throw error;
        }
      }
    }
    // Agent selection with its own generation model does not depend on the Auto
    // route, so run both selections at once instead of serializing two waits.
    const parallelAgent =
      body?.agent?.trim() === AUTO_AGENT_VALUE &&
      body?.auto === true &&
      canSwitchRoute &&
      body.autoRetry !== true &&
      autoAgentHasOwnModel()
        ? resolveAutoAgent({
            conversation: readSessionConversation(currentTask.sessionFile),
            prompt: body.prompt ?? "",
            hasImages: Boolean(body.images?.length),
            ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
          })
        : undefined;
    // Model routing may reject first; keep this rejection handled either way.
    parallelAgent?.catch(() => {});
    let model = body?.model;
    let thinkingLevel = body?.thinkingLevel;
    let autoDecision: AutoDecision | undefined;
    if (body?.auto === true && canSwitchRoute && body.autoRetry !== true) {
      autoDecision =
        (await resolveAutoModel({
          prompt: body.prompt ?? "",
          hasImages: Boolean(body.images?.length),
          attachmentCount: (body.images?.length ?? 0) + (body.files?.length ?? 0),
          historyMessageCount: readSessionConversation(currentTask.sessionFile).length,
          recentFailure:
            currentTask.status === "error" || Boolean(currentTask.error),
          mode: isAutoOptimizeMode(body.autoOptimize)
            ? body.autoOptimize
            : DEFAULT_AUTO_OPTIMIZE_MODE,
          config:
            body.autoRouteOverrides === undefined
              ? undefined
              : normalizeAutoRouteConfig(body.autoRouteOverrides),
        })) ?? undefined;
      if (!autoDecision) {
        return NextResponse.json(
          { error: "Auto で選択可能なモデルがありません" },
          { status: 400 },
        );
      }
      model = autoModelValue(autoDecision);
      thinkingLevel = autoVariantToThinkingLevel(autoDecision.variant);
    } else if (!canSwitchRoute) {
      model = undefined;
      thinkingLevel = undefined;
    }

    let agent = body?.agent;
    if (agent?.trim() === AUTO_AGENT_VALUE) {
      // An active turn cannot replace its session persona. The UI normally
      // disables this path, but keep a stale browser request safe as well.
      if (currentTask.status === "working") {
        agent = currentTask.agent?.trim() || undefined;
      } else {
        const taskModel =
          currentTask.providerID && currentTask.modelID
            ? {
                providerID: currentTask.providerID,
                modelID: currentTask.modelID,
                ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
              }
            : undefined;
        const requestedModel = parseDirectModelKey(model) ?? taskModel;
        agent = await (parallelAgent ??
          resolveAutoAgent({
            conversation: readSessionConversation(currentTask.sessionFile),
            prompt: body.prompt ?? "",
            hasImages: Boolean(body.images?.length),
            ...(requestedModel ? { requestedModel } : {}),
            ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
          }));
      }
    }
    const task = await promptTask(id, body.prompt ?? "", body.images, {
      files: body.files,
      model,
      thinkingLevel,
      ...(body?.auto === true ? { accountIdExplicit: false } : {}),
      agent,
      subagentPermission: body.subagentPermission,
      permissionMode,
      skillPermission: body.skillPermission,
      streamingBehavior: body.streamingBehavior,
      ...(body.resume === true ? { resume: true } : {}),
    });
    return NextResponse.json({ task, ...(autoDecision ? { autoDecision } : {}) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
