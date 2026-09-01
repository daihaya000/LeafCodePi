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
  setTaskAgent,
  setTaskModel,
  setTaskThinkingLevel,
} from "@/lib/pi/harness";
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
    if (body?.auto !== undefined && typeof body.auto !== "boolean") {
      return NextResponse.json({ error: "invalid auto" }, { status: 400 });
    }
    let agent = body?.agent?.trim() || undefined;
    if (agent === AUTO_AGENT_VALUE) {
      const currentTask = getTask(id);
      if (!currentTask) {
        return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
      }
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
        const requestedModel = parseDirectModelKey(body?.model) ?? taskModel;
        agent = await resolveAutoAgent({
          conversation: readSessionConversation(currentTask.sessionFile),
          prompt: goal,
          ...(requestedModel ? { requestedModel } : {}),
          ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
        });
      }
      if (agent && agent !== (currentTask.agent?.trim() || undefined)) {
        await setTaskAgent(id, agent);
      }
    }
    if (body?.model) await setTaskModel(id, body.model);
    if (body?.thinkingLevel) await setTaskThinkingLevel(id, body.thinkingLevel);
    const loop = await goalLoopCommand(id, {
      action: "start",
      goal,
      acceptance: criteria,
      maxTurns: clampGoalLoopMaxTurns(body?.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
      cooldownSeconds: clampGoalLoopCooldownSeconds(body?.cooldownSeconds),
      forceFullRun: body?.forceFullRun === true,
    });
    return NextResponse.json({ loop, agent: getTask(id)?.agent ?? null });
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
