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
  filterDirectGenerationCandidatesForActiveAgents,
  generateDirectTextWithFallbackResult,
  parseDirectModel,
  parseDirectModelKey,
} from "@/lib/direct-generation";
import { isGoalLoopLiveStatus } from "@/lib/goal-loop-settings";
import { readSettingValue } from "@/lib/host-control";
import { LLAMA_SERVER_SETTINGS_KEY, parseLlamaServerSettings } from "@/lib/llama-server-settings";
import { readTaskProgressSnapshot } from "@/lib/pi/harness";
import { LLAMA_SERVER_PROVIDER_ID } from "@/lib/pi/llama-provider";
import {
  buildTaskProgressPrompt,
  parseTaskProgressQuestion,
  TASK_PROGRESS_CANDIDATE_TIMEOUT_MS,
  TASK_PROGRESS_MAX_OUTPUT_TOKENS,
  TASK_PROGRESS_SERVER_TIMEOUT_MS,
  TASK_PROGRESS_SYSTEM_INSTRUCTION,
} from "@/lib/task-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_CHARS = 8_000;

const LOCAL_AGENT_BUSY_MESSAGE =
  "エージェントがローカルLLM（llama-server）で作業中のため、同じサーバーでは進捗を生成できません（エージェントの処理が遅れます）。設定 → モデル → 生成モデルに llama-server 以外のモデルを設定してください。";

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
  const configuredCandidates = buildDirectGenerationCandidates({
    primary: primaryModel,
    primaryEffort: configuredModel
      ? getSetting(GENERATION_MODEL_EFFORT_SETTING_KEY) || undefined
      : undefined,
    fallback: fallbackModel,
    fallbackEffort: fallbackModel
      ? getSetting(GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY) || undefined
      : undefined,
  });
  if (configuredCandidates.length === 0) {
    return NextResponse.json({ error: "生成モデルが設定されていません" }, { status: 400 });
  }
  // 実行中・圧縮中・Goal Loop のターン間は、エージェントのローカルLLMを横取りしない。
  const agentActive =
    snapshot.isStreaming || snapshot.isCompacting || isGoalLoopLiveStatus(snapshot.goalLoop?.status);
  const localAgent =
    agentActive &&
    task.providerID === LLAMA_SERVER_PROVIDER_ID &&
    task.modelID
      ? { taskId: task.id, providerID: task.providerID, modelID: task.modelID }
      : null;
  const parallelSlots = localAgent
    ? parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY)).parallel
    : 1;
  const candidates = localAgent
    ? filterDirectGenerationCandidatesForActiveAgents(configuredCandidates, [localAgent], parallelSlots)
    : configuredCandidates;
  if (candidates.length === 0) {
    return NextResponse.json({ error: LOCAL_AGENT_BUSY_MESSAGE }, { status: 409 });
  }

  try {
    const generated = await generateDirectTextWithFallbackResult({
      candidates,
      accountId: task.accountId,
      ...(task.accountIdExplicit ? { accountIdExplicit: true } : {}),
      system: TASK_PROGRESS_SYSTEM_INSTRUCTION,
      prompt,
      maxTokens: TASK_PROGRESS_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      timeoutMs: TASK_PROGRESS_CANDIDATE_TIMEOUT_MS,
      ...(localAgent ? { excludeProviderIDs: [LLAMA_SERVER_PROVIDER_ID] } : {}),
      // フォールバックを含めた全体の上限。ブラウザが切断・中止したら生成も止める。
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(TASK_PROGRESS_SERVER_TIMEOUT_MS)]),
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
