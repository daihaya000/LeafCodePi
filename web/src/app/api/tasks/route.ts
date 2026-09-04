import { NextRequest, NextResponse } from "next/server";
import { listTasks } from "@/lib/store";
import {
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
import { isPromptImageList } from "@/lib/prompt-images";
import { resolveAutoAgent } from "@/lib/auto-agent";
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
  // GlobalAttentionProvider のポーリング用（軽量リスト）。
  if (req.nextUrl.searchParams.get("attention") === "1") {
    return NextResponse.json({ attention: listPendingAttention() });
  }
  // TaskPanesContext のタブ名・存在確認用（todoProgress 計算と toSummary の
  // ライブ走査を伴わない生レコードで返す）。
  if (req.nextUrl.searchParams.get("titles") === "1") {
    return NextResponse.json({ tasks: listTasks(includeArchived) });
  }
  return NextResponse.json({ tasks: await getTaskSummariesWithTodoProgress(includeArchived) });
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
      thinkingLevel?: ThinkingLevel;
      auto?: unknown;
      autoOptimize?: unknown;
      autoRouteOverrides?: unknown;
      variant?: unknown;
      images?: { mimeType: string; data: string }[];
      agent?: string;
      accountId?: string;
      subagentPermission?: "allow" | "deny";
      permissionMode?: "allow" | "ask" | "deny";
      skillPermission?: "allow" | "deny";
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
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : null;
    if (body.model !== undefined && typeof body.model !== "string") {
      return NextResponse.json({ error: "invalid model" }, { status: 400 });
    }
    if (body.agent !== undefined && typeof body.agent !== "string") {
      return NextResponse.json({ error: "invalid agent" }, { status: 400 });
    }
    if (body.images !== undefined && !isPromptImageList(body.images)) {
      return NextResponse.json({ error: "invalid images" }, { status: 400 });
    }
    if (!body.prompt?.trim() && !body.images?.length) {
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
    if (body.goalLoop?.enabled === true && body.images?.length) {
      return NextResponse.json({ error: "Goal loop の開始では画像添付は使えません" }, { status: 400 });
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
    let thinkingLevel = body.thinkingLevel;
    let accountId =
      typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : undefined;
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
    if (body.model && body.auto !== true) {
      await validateTaskModelSelection(body.model, accountId ?? null, {
        accountIdExplicit: Boolean(accountId || requestedModel?.accountId),
      });
    }
    let agent = body.agent?.trim() || undefined;
    let autoDecision: AutoDecision | undefined;
    const autoRouteConfig: AutoRouteConfig | undefined =
      body.autoRouteOverrides === undefined
        ? undefined
        : normalizeAutoRouteConfig(body.autoRouteOverrides);
    if (body.auto === true) {
      const hasImages = Boolean(body.images?.length);
      autoDecision =
        (await resolveAutoModel({
          prompt,
          hasImages,
          attachmentCount: body.images?.length ?? 0,
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
      agent = await resolveAutoAgent({
        conversation: [],
        prompt,
        hasImages: Boolean(body.images?.length),
        ...(selectionModel ? { requestedModel: selectionModel } : {}),
        ...(accountId ? { accountId } : {}),
      });
    }
    const task = await createTask({
      projectId,
      prompt,
      ...(model && model !== AUTO_MODEL_VALUE ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      images: body.images,
      ...(agent ? { agent } : {}),
      accountId,
      accountIdExplicit: body.auto !== true,
      subagentPermission: body.subagentPermission,
      permissionMode: body.permissionMode,
      skillPermission: body.skillPermission,
      goalLoop,
    });
    return NextResponse.json({ task, ...(autoDecision ? { autoDecision } : {}) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
