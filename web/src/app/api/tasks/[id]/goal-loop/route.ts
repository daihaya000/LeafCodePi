import { NextRequest, NextResponse } from "next/server";
import {
  startGoalLoopWithSelection,
  normalizeGoalLoopStartAcceptance as acceptance,
  type GoalLoopStartBody,
} from "@/lib/pi/goal-loop-start";
import { isGoalLoopLiveStatus } from "@/lib/pi/goal-loop-state";
import { botIdForCodeTask } from "@/lib/pi/bot-code-relay";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardGoalLoopControl, forwardGoalLoopStart } from "@/lib/backend-forward";
import {
  goalLoopCommand,
  goalLoopState,
  jsonError,
  stopBotCodeTask,
} from "@/lib/pi/harness";
import {
  clampGoalLoopCooldownSeconds,
  clampGoalLoopMaxTurns,
  DEFAULT_GOAL_LOOP_MAX_TURNS,
} from "@/lib/goal-loop-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type Body = GoalLoopStartBody & {
  action?: "start" | "pause" | "resume" | "stop" | "complete";
};

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const loop = await goalLoopState(id, { offline: true });
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
    // Starting resolves Auto/model/agent locally, so an override is refused; a plain start is forwarded
    // to the process that owns the session. Pause/resume/stop/complete are forwarded below (see PATCH).
    if (localRuntimeBlocked()) {
      const needsLocalResolution =
        body?.auto !== undefined ||
        body?.model !== undefined ||
        body?.agent !== undefined ||
        body?.thinkingLevel !== undefined ||
        body?.autoOptimize !== undefined ||
        body?.autoRouteOverrides !== undefined;
      if (needsLocalResolution) {
        return NextResponse.json(
          { error: "Auto/モデル指定つきのGoal Loop開始は非所有モードでは未対応です", code: "GOAL_LOOP_START_NOT_SUPPORTED" },
          { status: 409 },
        );
      }
      const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
      const criteria = acceptance(body?.acceptance);
      if (!goal || goal.length > 4_000 || !criteria) {
        return NextResponse.json({ error: "goal または acceptance が不正です" }, { status: 400 });
      }
      const forwarded = await forwardGoalLoopStart(id, {
        goal,
        acceptance: criteria,
        maxTurns: clampGoalLoopMaxTurns(body?.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS),
        cooldownSeconds: clampGoalLoopCooldownSeconds(body?.cooldownSeconds),
        forceFullRun: body?.forceFullRun === true,
        ...(body?.images !== undefined ? { images: body.images } : {}),
      });
      if (forwarded.ok) {
        const loop = forwarded.loop as { status?: string } | null;
        if (!loop || !isGoalLoopLiveStatus(loop.status)) {
          return NextResponse.json({ error: "Goal Loop を開始できませんでした" }, { status: 409 });
        }
        return NextResponse.json({ loop, agent: null });
      }
      if (forwarded.reason === "not-configured") {
        return NextResponse.json({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" }, { status: 409 });
      }
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "Backendへ転送できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
        { status: 502 },
      );
    }
    return NextResponse.json(await startGoalLoopWithSelection(id, body!));
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
    // The loop runs inside the owner: a local control would find no loop and leave the real one running.
    if (localRuntimeBlocked()) {
      const botId = botIdForCodeTask(id);
      const forwarded = await forwardGoalLoopControl(id, {
        action,
        ...(action === "resume" && body?.maxTurns !== undefined
          ? { maxTurns: clampGoalLoopMaxTurns(body.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS) }
          : {}),
        ...(botId ? { botId } : {}),
      });
      if (forwarded.ok) return NextResponse.json({ loop: forwarded.loop });
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "Goal Loop が見つかりません" }, { status: 404 });
      }
      if (forwarded.reason === "not-configured") {
        return NextResponse.json({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" }, { status: 409 });
      }
      return NextResponse.json(
        { error: "Backendへ転送できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
        { status: 502 },
      );
    }
    // Bot-owned Code: Goal Loop stop must mark the outbox like Bot panel / tasks abort.
    if (action === "stop") {
      const botId = botIdForCodeTask(id);
      if (botId) {
        await stopBotCodeTask(botId, id);
        return NextResponse.json({ loop: await goalLoopState(id, { offline: true }) });
      }
    }
    const loop = await goalLoopCommand(id, {
      action,
      maxTurns:
        action === "resume" && body?.maxTurns !== undefined
          ? clampGoalLoopMaxTurns(body.maxTurns, DEFAULT_GOAL_LOOP_MAX_TURNS)
          : undefined,
    });
    if (action === "resume" && (!loop || !isGoalLoopLiveStatus(loop.status))) {
      return NextResponse.json(
        { error: "Goal Loop を再開できませんでした" },
        { status: 409 },
      );
    }
    return NextResponse.json({ loop });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
