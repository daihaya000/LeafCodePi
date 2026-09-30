import { NextRequest, NextResponse } from "next/server";
import { jsonError, respondToQuestionPrompt } from "@/lib/pi/harness";
import type { QuestionAnswer } from "@/lib/pi/question-prompt";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardQuestionAnswer } from "@/lib/backend-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidAnswers(answers: unknown): answers is string[][] {
  return (
    Array.isArray(answers) &&
    answers.every(
      (row) => Array.isArray(row) && row.every((v) => typeof v === "string" && v.trim().length > 0),
    )
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as
      | { requestId?: unknown; answers?: unknown; reject?: unknown }
      | null;
    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }

    if (body?.reject !== undefined && typeof body.reject !== "boolean") {
      return NextResponse.json({ error: "reject must be a boolean" }, { status: 400 });
    }

    let answer: QuestionAnswer | null = null;
    if (!body?.reject) {
      if (!isValidAnswers(body?.answers)) {
        return NextResponse.json({ error: "answers（string[][]）が必要です" }, { status: 400 });
      }
      answer = { answers: body!.answers as string[][] };
    }

    // After the cutover the pending question lives in the Backend, so the answer goes there.
    if (localRuntimeBlocked()) {
      const forwarded = await forwardQuestionAnswer(id, { requestId, ...(answer ? { answer } : {}) });
      if (forwarded.ok) return NextResponse.json({ ok: true });
      if (forwarded.reason === "not-found") {
        return NextResponse.json({ error: "question request not found" }, { status: 404 });
      }
      if (forwarded.reason === "not-configured") {
        return NextResponse.json({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" }, { status: 409 });
      }
      return NextResponse.json(
        { error: "Backendへ回答できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason },
        { status: 502 },
      );
    }
    const ok = respondToQuestionPrompt(id, requestId, answer);
    if (!ok) {
      return NextResponse.json({ error: "question request not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
