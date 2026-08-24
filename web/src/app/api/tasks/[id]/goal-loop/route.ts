import { NextRequest, NextResponse } from "next/server";
import { goalLoopCommand, goalLoopState, jsonError } from "@/lib/pi/harness";
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
    const loop = await goalLoopCommand(id, {
      action: "start",
      goal,
      acceptance: criteria,
      maxTurns: clampGoalLoopMaxTurns(body?.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
      cooldownSeconds: clampGoalLoopCooldownSeconds(body?.cooldownSeconds),
      forceFullRun: body?.forceFullRun === true,
    });
    return NextResponse.json({ loop });
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
