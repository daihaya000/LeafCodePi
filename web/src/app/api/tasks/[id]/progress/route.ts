import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/pi/web-settings";
import {
  GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY,
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";
import {
  buildDirectGenerationCandidates,
  generateDirectTextWithFallbackResult,
  parseDirectModel,
  parseDirectModelKey,
} from "@/lib/direct-generation";
import { readTaskProgressSnapshot } from "@/lib/pi/harness";
import {
  buildTaskProgressPrompt,
  parseTaskProgressQuestion,
  TASK_PROGRESS_SYSTEM_INSTRUCTION,
} from "@/lib/task-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_CHARS = 8_000;

function errorResponse(error: unknown, fallback: string): NextResponse {
  const status =
    typeof error === "object" && error && "status" in error && typeof error.status === "number"
      ? error.status
      : 502;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status },
  );
}

/**
 * 実行中のエージェントを止めずに、生成モデルへ現在の進捗・要約を質問する。
 * セッションは読み取るだけで、質問も回答もエージェントの会話には入れない。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_REQUEST_CHARS) {
    return NextResponse.json({ error: "request body is too large" }, { status: 413 });
  }
  const body = (() => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  })();
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
  }
  const parsedQuestion = parseTaskProgressQuestion(body.question);
  if (!parsedQuestion.ok) {
    return NextResponse.json({ error: parsedQuestion.error }, { status: 400 });
  }

  const { id } = await params;
  let snapshot: Awaited<ReturnType<typeof readTaskProgressSnapshot>>;
  try {
    snapshot = await readTaskProgressSnapshot(id);
  } catch (error) {
    return errorResponse(error, "セッションを読み取れませんでした");
  }
  const { task } = snapshot;
  const snapshotAt = Date.now();
  const prompt = buildTaskProgressPrompt({
    ...snapshot,
    title: task.title,
    error: task.status === "error" ? task.error : null,
    now: snapshotAt,
    question: parsedQuestion.question,
  });
  if (!prompt) {
    return NextResponse.json(
      { error: "進捗を確認できる会話・ToDo・作業記録がまだありません" },
      { status: 422 },
    );
  }

  const configuredModel = parseDirectModelKey(getSetting(GENERATION_MODEL_SETTING_KEY));
  const primaryModel =
    configuredModel ??
    parseDirectModel(body.model) ??
    parseDirectModel({ providerID: task.providerID, modelID: task.modelID });
  const fallbackModel = parseDirectModelKey(getSetting(GENERATION_FALLBACK_MODEL_SETTING_KEY));
  const candidates = buildDirectGenerationCandidates({
    primary: primaryModel,
    primaryEffort: configuredModel
      ? getSetting(GENERATION_MODEL_EFFORT_SETTING_KEY) || undefined
      : undefined,
    fallback: fallbackModel,
    fallbackEffort: fallbackModel
      ? getSetting(GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY) || undefined
      : undefined,
  });
  if (candidates.length === 0) {
    return NextResponse.json({ error: "生成モデルが設定されていません" }, { status: 400 });
  }

  try {
    const generated = await generateDirectTextWithFallbackResult({
      candidates,
      accountId: task.accountId,
      ...(task.accountIdExplicit ? { accountIdExplicit: true } : {}),
      system: TASK_PROGRESS_SYSTEM_INSTRUCTION,
      prompt,
      maxTokens: 1_024,
      temperature: 0.2,
      timeoutMs: 90_000,
    });
    const answer = generated.text.trim();
    if (!answer) throw new Error("進捗の回答が空です");
    return NextResponse.json({
      answer,
      question: parsedQuestion.question,
      model: generated.model,
      source: "direct",
      snapshotAt,
      working: snapshot.isStreaming,
    });
  } catch (error) {
    return errorResponse(error, "進捗の確認に失敗しました");
  }
}
