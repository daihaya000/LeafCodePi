import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { readSessionConversation } from "@/lib/direct-session";
import { parseDirectModelKey } from "@/lib/direct-generation";
import { resolveAutoAgent } from "@/lib/auto-agent";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import { jsonError, promptTask, resolveAutoModel } from "@/lib/pi/harness";
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
      model?: string;
      thinkingLevel?: ThinkingLevel;
      auto?: unknown;
      autoRetry?: unknown;
      autoOptimize?: unknown;
      autoRouteOverrides?: unknown;
      agent?: string;
      subagentPermission?: "allow" | "deny";
      permissionMode?: "allow" | "ask" | "deny";
      skillPermission?: "allow" | "deny";
      streamingBehavior?: "steer" | "followUp";
    } | null;
    if (!body?.prompt?.trim() && !body?.images?.length) {
      return NextResponse.json({ error: "prompt が必要です" }, { status: 400 });
    }
    if (body?.agent !== undefined && typeof body.agent !== "string") {
      return NextResponse.json({ error: "invalid agent" }, { status: 400 });
    }
    if (body?.auto !== undefined && typeof body.auto !== "boolean") {
      return NextResponse.json({ error: "invalid auto" }, { status: 400 });
    }
    if (body?.autoRetry !== undefined && typeof body.autoRetry !== "boolean") {
      return NextResponse.json({ error: "invalid autoRetry" }, { status: 400 });
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
    let model = body?.model;
    let thinkingLevel = body?.thinkingLevel;
    let autoDecision: AutoDecision | undefined;
    const canSwitchRoute =
      currentTask.status !== "working" && body?.streamingBehavior === undefined;
    if (body?.auto === true && canSwitchRoute && body.autoRetry !== true) {
      autoDecision =
        (await resolveAutoModel({
          prompt: body.prompt ?? "",
          hasImages: Boolean(body.images?.length),
          attachmentCount: body.images?.length ?? 0,
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
        agent = await resolveAutoAgent({
          conversation: readSessionConversation(currentTask.sessionFile),
          prompt: body.prompt ?? "",
          hasImages: Boolean(body.images?.length),
          ...(requestedModel ? { requestedModel } : {}),
          ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
        });
      }
    }
    const task = await promptTask(id, body.prompt ?? "", body.images, {
      model,
      thinkingLevel,
      accountIdExplicit: body?.auto !== true,
      agent,
      subagentPermission: body.subagentPermission,
      permissionMode: body.permissionMode,
      skillPermission: body.skillPermission,
      streamingBehavior: body.streamingBehavior,
    });
    return NextResponse.json({ task, ...(autoDecision ? { autoDecision } : {}) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
