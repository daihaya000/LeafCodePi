import { NextRequest, NextResponse } from "next/server";
import { jsonError, respondToQuestionPrompt } from "@/lib/pi/harness";
import type { QuestionAnswer } from "@/lib/pi/question-prompt";

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
      | { requestId?: string; answers?: unknown; reject?: boolean }
      | null;
    const requestId = body?.requestId?.trim();
    if (!requestId) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }

    let answer: QuestionAnswer | null = null;
    if (!body?.reject) {
      if (!isValidAnswers(body?.answers)) {
        return NextResponse.json({ error: "answers（string[][]）が必要です" }, { status: 400 });
      }
      answer = { answers: body!.answers as string[][] };
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
