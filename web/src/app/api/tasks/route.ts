import { NextRequest, NextResponse } from "next/server";
import { relayFallbackAllowed, relayTaskRows } from "@/lib/backend-relay";
import { forwardPendingAttention } from "@/lib/backend-forward";
import { createTaskOnBackend } from "@/lib/backend-client";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { listTasks, type TaskKind } from "@/lib/store";
import { reconcileOrphanedWorkingTasks } from "@/lib/task-runtime-lease";
import {
  autoArchiveOldTasks,
  createTask,
  destroyArchivedTasksByProject,
  getTaskSummariesWithTodoProgress,
  jsonError,
  resolveAutoModel,
  listPendingAttention,
  validateTaskModelSelection,
} from "@/lib/pi/harness";
import {
  autoModelValue,
  autoVariantToThinkingLevel,
  AUTO_MODEL_VALUE,
  DEFAULT_AUTO_OPTIMIZE_MODE,
  isAutoOptimizeMode,
  normalizeAutoRouteConfig,
  type AutoDecision,
  type AutoRouteConfig,
} from "@/lib/auto-model";
import { parseDirectModelKey } from "@/lib/direct-generation";
import {
  isPromptFileList,
  isPromptFileText,
  isPromptFileWithinSize,
  isPromptImageList,
  isPromptImageWithinSize,
  isPromptTextWithinSize,
  MAX_PROMPT_ATTACHMENTS,
  type PromptFileInput,
} from "@/lib/prompt-images";
import { isThinkingLevel } from "@/lib/thinking-levels";
import { autoAgentHasOwnModel, resolveAutoAgent } from "@/lib/auto-agent";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
} from "@/lib/goal-loop-settings";
import type { ThinkingLevel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  const requestedKind = req.nextUrl.searchParams.get("kind");
  const kind: TaskKind = requestedKind === "all" || requestedKind === "bot" ? requestedKind : "code";
  // GlobalAttentionProvider のポーリング用（軽量リスト）。
  // 切替後は承認・質問がBackendのメモリにあるため、非所有者はそこから読む（ローカルには無い）。
  if (req.nextUrl.searchParams.get("attention") === "1") {
    if (!relayFallbackAllowed()) {
      const forwarded = await forwardPendingAttention();
      if (!forwarded.ok) {
        return NextResponse.json({ error: "Backendの注意一覧を取得できません" }, { status: 503 });
      }
      return NextResponse.json({ attention: forwarded.items });
    }
    return NextResponse.json({ attention: listPendingAttention() });
  }
  // ペインヘッダーの操作はタスクの ID・状態・時刻だけ必要。Todo 進捗の
  // セッション走査や自動アーカイブを待たず、ボタンをすぐ反応させる。
  if (req.nextUrl.searchParams.get("paneCandidates") === "1") {
    // 生レコードだけを返すため、通常の summary 経路が担う孤児タスクの
    // 停止処理をここでも実行する。再起動後の古い working を開かない。
    reconcileOrphanedWorkingTasks();
    // 中継が有効ならBackendの生レコードを使う（形は同じ）。
    // 切替後はこのプロセスが所有者ではないので、読めないなら従来経路へ落とさずエラーにする。
    const relayedRows = await relayTaskRows({ includeArchived: false, kind: "all" });
    if (!relayedRows && !relayFallbackAllowed()) {
      return NextResponse.json({ error: "Backendのタスク一覧を取得できません" }, { status: 503 });
    }
    return NextResponse.json({
      tasks: (relayedRows ?? listTasks(false, "all")).map(({ id, status, updatedAt, kind, botId, projectId }) => ({
        id, status, updatedAt, kind, botId, projectId,
      })),
    });
  }
  await autoArchiveOldTasks();
  // TaskPanesContext のタブ名・存在確認用（todoProgress 計算と toSummary の
  // ライブ走査を伴わない生レコードで返す）。
  if (req.nextUrl.searchParams.get("titles") === "1") {
    // 中継が有効ならBackendの行を使う（保存行そのもので形は同じ）。
    const relayedTitles = await relayTaskRows({ includeArchived, kind });
    if (!relayedTitles && !relayFallbackAllowed()) {
      return NextResponse.json({ error: "Backendのタスク一覧を取得できません" }, { status: 503 });
    }
    return NextResponse.json({ tasks: relayedTitles ?? listTasks(includeArchived, kind) });
  }
  return NextResponse.json({ tasks: await getTaskSummariesWithTodoProgress(includeArchived, kind) });
}

export async function DELETE(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get("projectId");
    const noProject = req.nextUrl.searchParams.get("noProject") === "1";
    if (!projectId && !noProject) {
      return NextResponse.json({ error: "projectId or noProject is required" }, { status: 400 });
    }
    return NextResponse.json(await destroyArchivedTasksByProject(noProject ? null : projectId));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      projectId?: string | null;
      prompt?: string;
      model?: string;
      thinkingLevel?: unknown;
      auto?: unknown;
      autoOptimize?: unknown;
      autoRouteOverrides?: unknown;
      variant?: unknown;
      images?: { mimeType: string; data: string }[];
      files?: PromptFileInput[];
      agent?: string;
      accountId?: unknown;
      accountIdExplicit?: unknown;
      goalLoop?: {
        enabled?: unknown;
        acceptance?: unknown;
        maxTurns?: unknown;
        cooldownSeconds?: unknown;
        forceFullRun?: unknown;
      };
    } | null;
    if (
      !body ||
      (body.projectId !== null &&
        (typeof body.projectId !== "string" || !body.projectId.trim())) ||
      (body.prompt !== undefined && typeof body.prompt !== "string")
    ) {
      return NextResponse.json(
        { error: "projectId（null可）と prompt が必要です" },
        { status: 400 },
      );
    }
    if (body.prompt !== undefined && !isPromptTextWithinSize(body.prompt)) {
      return NextResponse.json({ error: "本文プロンプトが長すぎます" }, { status: 413 });
    }
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : null;
    const thinkingLevelInput = body.thinkingLevel;
    if (thinkingLevelInput !== undefined && !isThinkingLevel(thinkingLevelInput)) {
      return NextResponse.json({ error: "invalid thinkingLevel" }, { status: 400 });
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      return NextResponse.json({ error: "invalid model" }, { status: 400 });
    }
    if (body.agent !== undefined && typeof body.agent !== "string") {
      return NextResponse.json({ error: "invalid agent" }, { status: 400 });
    }
    if (body.images !== undefined && (!isPromptImageList(body.images) || body.images.some((image) => !isPromptImageWithinSize(image)))) {
      return NextResponse.json({ error: "invalid images" }, { status: 400 });
    }
    if (body.files !== undefined && (!isPromptFileList(body.files) || body.files.some((file) => !isPromptFileWithinSize(file) || !isPromptFileText(file)))) {
      return NextResponse.json({ error: "invalid files: UTF-8 text only" }, { status: 400 });
    }
    if ((body.images?.length ?? 0) + (body.files?.length ?? 0) > MAX_PROMPT_ATTACHMENTS) {
      return NextResponse.json({ error: `添付は${MAX_PROMPT_ATTACHMENTS}件までです` }, { status: 400 });
    }
    if (!body.prompt?.trim() && !body.images?.length && !body.files?.length) {
      return NextResponse.json(
        { error: "projectId（null可）と prompt が必要です" },
        { status: 400 },
      );
    }
    const prompt = body.prompt ?? "";
    if (body.auto !== undefined && typeof body.auto !== "boolean") {
      return NextResponse.json({ error: "invalid auto" }, { status: 400 });
    }
    if (body.autoOptimize !== undefined && !isAutoOptimizeMode(body.autoOptimize)) {
      return NextResponse.json({ error: "invalid autoOptimize" }, { status: 400 });
    }
    if (body.autoOptimize !== undefined && body.auto !== true) {
      return NextResponse.json(
        { error: "autoOptimize requires auto" },
        { status: 400 },
      );
    }
    if (body.autoRouteOverrides !== undefined && body.auto !== true) {
      return NextResponse.json(
        { error: "autoRouteOverrides requires auto" },
        { status: 400 },
      );
    }
    if (body.auto === true && body.model?.trim()) {
      return NextResponse.json(
        { error: "auto and model are mutually exclusive" },
        { status: 400 },
      );
    }
    if (
      body.auto === true &&
      typeof body.variant === "string" &&
      body.variant.trim()
    ) {
      return NextResponse.json(
        { error: "variant cannot be set with auto" },
        { status: 400 },
      );
    }
    if (body.goalLoop?.enabled === true && body.files?.length) {
      return NextResponse.json({ error: "Goal loop の開始では画像のみ添付できます" }, { status: 400 });
    }
    let goalLoop:
      | { acceptance: string[]; maxTurns: number; cooldownSeconds: number; forceFullRun: boolean }
      | undefined;
    if (body.goalLoop?.enabled === true) {
      const raw = body.goalLoop.acceptance;
      const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : [];
      if (
        values.length > 10 ||
        values.some((item) => typeof item !== "string" || item.trim().length > 2_000)
      ) {
        return NextResponse.json({ error: "acceptance が不正です" }, { status: 400 });
      }
      goalLoop = {
        acceptance: values
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
        maxTurns: clampGoalLoopMaxTurns(body.goalLoop.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
        cooldownSeconds: clampGoalLoopCooldownSeconds(body.goalLoop.cooldownSeconds),
        forceFullRun: body.goalLoop.forceFullRun === true,
      };
    }
    let model = body.model;
    let thinkingLevel: ThinkingLevel | undefined = thinkingLevelInput;
    const accountIdInput = body.accountId;
    if (accountIdInput !== undefined && typeof accountIdInput !== "string") {
      return NextResponse.json({ error: "invalid accountId" }, { status: 400 });
    }
    let accountId = accountIdInput?.trim() || undefined;
    const requestedModel =
      body.model && body.model !== AUTO_MODEL_VALUE
        ? parseDirectModelKey(body.model)
        : undefined;
    if (requestedModel?.accountId && accountId && requestedModel.accountId !== accountId) {
      return NextResponse.json(
        { error: "モデルとアカウントの指定が一致しません" },
        { status: 400 },
      );
    }
    // Soft body.accountId alone is a preference. Pin only when the client asks
    // (accountIdExplicit) or the model string still carries an account prefix.
    const requestedAccountExplicit =
      body.accountIdExplicit === true || Boolean(requestedModel?.accountId);
    if (body.model && body.auto !== true) {
      await validateTaskModelSelection(body.model, accountId ?? null, {
        accountIdExplicit: requestedAccountExplicit,
      });
    }
    let agent = body.agent?.trim() || undefined;
    const autoAgentRequested = agent === AUTO_AGENT_VALUE;
    let autoDecision: AutoDecision | undefined;
    const autoRouteConfig: AutoRouteConfig | undefined =
      body.autoRouteOverrides === undefined
        ? undefined
        : normalizeAutoRouteConfig(body.autoRouteOverrides);
    // Agent selection with its own generation model does not depend on the Auto
    // route, so run both selections at once instead of serializing two waits.
    const parallelAgent =
      agent === AUTO_AGENT_VALUE && body.auto === true && autoAgentHasOwnModel()
        ? resolveAutoAgent({
            conversation: [],
            prompt,
            hasImages: Boolean(body.images?.length),
          })
        : undefined;
    // Model routing may reject first; keep this rejection handled either way.
    parallelAgent?.catch(() => {});
    if (body.auto === true) {
      const hasImages = Boolean(body.images?.length);
      autoDecision =
        (await resolveAutoModel({
          prompt,
          hasImages,
          attachmentCount: (body.images?.length ?? 0) + (body.files?.length ?? 0),
          mode: isAutoOptimizeMode(body.autoOptimize)
            ? body.autoOptimize
            : DEFAULT_AUTO_OPTIMIZE_MODE,
          config: autoRouteConfig,
        })) ?? undefined;
      if (!autoDecision) {
        throw Object.assign(
          new Error(
            "Auto で選択可能なモデルがありません。プロバイダ接続とモデル有効化を確認してください。",
          ),
          { status: 400 },
        );
      }
      model = autoModelValue(autoDecision);
      thinkingLevel = autoVariantToThinkingLevel(autoDecision.variant);
      accountId = autoDecision.accountId;
    }
    if (agent === AUTO_AGENT_VALUE) {
      const selectionModel = autoDecision
        ? {
            providerID: autoDecision.providerID,
            modelID: autoDecision.modelID,
            ...(autoDecision.accountId ? { accountId: autoDecision.accountId } : {}),
          }
        : requestedModel && accountId && !requestedModel.accountId
          ? { ...requestedModel, accountId }
          : requestedModel;
      agent = await (parallelAgent ??
        resolveAutoAgent({
          conversation: [],
          prompt,
          hasImages: Boolean(body.images?.length),
          ...(selectionModel ? { requestedModel: selectionModel } : {}),
          ...(accountId ? { accountId } : {}),
          // Pinned create (non-auto) must not silently pick another account for agent selection.
          ...(body.auto !== true && requestedAccountExplicit && accountId
            ? { accountIdExplicit: true }
            : {}),
        }));
    }
    const input = {
      projectId,
      prompt,
      ...(model && model !== AUTO_MODEL_VALUE ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      images: body.images,
      files: body.files,
      ...(agent ? { agent } : {}),
      accountId,
      ...(body.auto === true
        ? { accountIdExplicit: false }
        : requestedAccountExplicit
          ? { accountIdExplicit: true }
          : {}),
      // Permissions come from Settings (resolved by createTask), not the request.
      goalLoop: goalLoop
        ? { ...goalLoop, autoAgent: autoAgentRequested }
        : undefined,
    };
    if (localRuntimeBlocked()) {
      const forwarded = await createTaskOnBackend(input, { timeoutMs: 60_000 });
      if (!forwarded.ok) {
        // Runtime validation failures are owner answers, not failed transport. Never retry locally.
        if (forwarded.reason === "bad-response" && forwarded.status && [400, 404, 413, 422].includes(forwarded.status)) {
          return NextResponse.json(
            { error: forwarded.status === 404 ? "プロジェクトが見つかりません" : "タスクを作成できません" },
            { status: forwarded.status },
          );
        }
        return NextResponse.json(
          { error: "Backendでタスクを作成できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
          { status: 502 },
        );
      }
      return NextResponse.json({ task: forwarded.body.task, ...(autoDecision ? { autoDecision } : {}) });
    }
    const task = await createTask(input);
    return NextResponse.json({ task, ...(autoDecision ? { autoDecision } : {}) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
