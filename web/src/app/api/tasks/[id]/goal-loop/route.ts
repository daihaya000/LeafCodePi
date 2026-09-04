import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { readSessionConversation } from "@/lib/direct-session";
import { parseDirectModelKey } from "@/lib/direct-generation";
import { resolveAutoAgent } from "@/lib/auto-agent";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
import {
  goalLoopCommand,
  goalLoopState,
  jsonError,
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
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
} from "@/lib/goal-loop-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type Body = {
  action?: "start" | "pause" | "resume" | "stop" | "complete";
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
};

function acceptance(value: unknown): string[] | null {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : null;
  if (!values || values.length > 10) return null;
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text) continue;
    if (text.length > 2_000) return null;
    result.push(text);
  }
  return result;
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const loop = await goalLoopState(id);
    return NextResponse.json({ loop });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as Body | null;
    const action = body?.action;
    if (action !== "start") {
      return NextResponse.json({ error: "POST の action は start です" }, { status: 400 });
    }
    const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
    const criteria = acceptance(body?.acceptance);
    if (!goal || goal.length > 4_000 || !criteria) {
      return NextResponse.json({ error: "goal または acceptance が不正です" }, { status: 400 });
    }
    if (body?.agent !== undefined && typeof body.agent !== "string") {
      return NextResponse.json({ error: "invalid agent" }, { status: 400 });
    }
    if (body?.model !== undefined && typeof body.model !== "string") {
      return NextResponse.json({ error: "invalid model" }, { status: 400 });
    }
    if (body?.auto !== undefined && typeof body.auto !== "boolean") {
      return NextResponse.json({ error: "invalid auto" }, { status: 400 });
    }
    if (body?.autoOptimize !== undefined && !isAutoOptimizeMode(body.autoOptimize)) {
      return NextResponse.json({ error: "invalid autoOptimize" }, { status: 400 });
    }
    if (
      (body?.autoOptimize !== undefined || body?.autoRouteOverrides !== undefined) &&
      body?.auto !== true
    ) {
      return NextResponse.json({ error: "Auto設定にはautoが必要です" }, { status: 400 });
    }
    const currentTask = getTask(id);
    if (!currentTask) {
      return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
    }
    if (
      currentTask.status !== "working" &&
      body?.model &&
      body.auto !== true
    ) {
      await validateTaskModelSelection(body.model);
    }
    let model = body?.model;
    let thinkingLevel = body?.thinkingLevel;
    let autoDecision: AutoDecision | undefined;
    if (body?.auto === true && currentTask.status !== "working") {
      autoDecision =
        (await resolveAutoModel({
          prompt: goal,
          hasImages: false,
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
    } else if (currentTask.status === "working") {
      model = undefined;
      thinkingLevel = undefined;
    }
    let agent = body?.agent?.trim() || undefined;
    if (agent === AUTO_AGENT_VALUE) {
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
          prompt: goal,
          ...(requestedModel ? { requestedModel } : {}),
          ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
        });
      }
    }
    if (agent && agent !== (currentTask.agent?.trim() || undefined)) {
      await setTaskAgent(id, agent);
    }
    if (model) {
      await setTaskModel(id, model, { accountIdExplicit: body?.auto !== true });
    }
    if (thinkingLevel) await setTaskThinkingLevel(id, thinkingLevel);
    const loop = await goalLoopCommand(id, {
      action: "start",
      goal,
      acceptance: criteria,
      maxTurns: clampGoalLoopMaxTurns(body?.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
      cooldownSeconds: clampGoalLoopCooldownSeconds(body?.cooldownSeconds),
      forceFullRun: body?.forceFullRun === true,
    });
    return NextResponse.json({
      loop,
      agent: getTask(id)?.agent ?? null,
      ...(autoDecision ? { autoDecision } : {}),
    });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as Body | null;
    const action = body?.action;
    if (action !== "pause" && action !== "resume" && action !== "stop" && action !== "complete") {
      return NextResponse.json({ error: "action は pause/resume/stop/complete のいずれかです" }, { status: 400 });
    }
    const loop = await goalLoopCommand(id, {
      action,
      maxTurns:
        action === "resume" && body?.maxTurns !== undefined
          ? clampGoalLoopMaxTurns(body.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS)
          : undefined,
    });
    return NextResponse.json({ loop });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
