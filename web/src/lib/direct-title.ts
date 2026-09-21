import { getTask, patchTask } from "@/lib/store";
import { getSetting } from "@/lib/pi/web-settings";
import {
  GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY,
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";
import {
  buildDirectGenerationCandidates,
  DirectGenerationError,
  generateDirectTextWithFallbackResult,
  parseDirectModel,
  parseDirectModelKey,
  type DirectModel,
} from "@/lib/direct-generation";
import { readSessionConversation, readSessionWorkSummary } from "@/lib/direct-session";
import {
  formatTranscriptForTitle,
  formatWorkSummaryForTitle,
  splitTitleAndLabel,
} from "@/lib/direct-generation-text";
import { classifySessionLabelWithJev, matchSessionLabelByRule } from "@/lib/auto-jev";
import {
  AUTO_JEV_ENABLED_SETTING_KEY,
  AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY,
  isAutoJevEnabled,
  parseAutoJevMinConfidence,
} from "@/lib/auto-jev-settings";
import {
  resolveSessionLabels,
  SESSION_LABELS_SETTING_KEY,
  type SessionLabel,
} from "@/lib/session-label-settings";

const TITLE_SYSTEM_INSTRUCTION =
  "会話を要約する簡潔な日本語タイトルを1件だけ生成してください。タイトルのみを返し、説明、引用符、見出し、改行は不要です。";

/** The label line rides along with the title response, so it costs no extra request. */
function titleSystemInstruction(labels: readonly SessionLabel[]): string {
  if (labels.length < 2) return TITLE_SYSTEM_INSTRUCTION;
  return [
    "1行目に会話を要約する簡潔な日本語タイトルを1件だけ出力してください。",
    `2行目に「ラベル: <名前>」の形式で、次のいずれか1つだけを出力してください: ${labels.map((label) => label.name).join(" / ")}`,
    "該当するものがなければ2行目を省略してください。",
    "説明、引用符、見出し、その他の行は不要です。",
  ].join("\n");
}

function labelIdByName(
  labels: readonly SessionLabel[],
  name: string | null,
): string | undefined {
  if (!name) return undefined;
  return labels.find((label) => label.name === name)?.id;
}

export async function refreshTaskTitleDirect(
  taskId: string,
  requestedModel?: DirectModel,
): Promise<{
  title: string;
  label?: string;
  task: ReturnType<typeof patchTask>;
  model: DirectModel;
}> {
  const task = getTask(taskId);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const conversation = readSessionConversation(task.sessionFile);
  // 圧縮直後・履歴退避などで会話が取れない時は ToDo と作業ログから生成する
  const prompt =
    formatTranscriptForTitle(conversation) ||
    formatWorkSummaryForTitle(readSessionWorkSummary(task.sessionFile));
  if (!prompt) {
    throw new DirectGenerationError("タイトルを生成できる会話・ToDo・作業ログがありません", 422);
  }

  const configuredModel = parseDirectModelKey(getSetting(GENERATION_MODEL_SETTING_KEY));
  const primaryModel =
    configuredModel ??
    requestedModel ??
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
  if (candidates.length === 0) throw new DirectGenerationError("生成モデルが設定されていません", 400);

  // ponytail: サーバは設定のミラーを読む。CRUD 直後の書き込みが未達なら1回だけ古い定義で分類する。
  const labels = resolveSessionLabels(getSetting(SESSION_LABELS_SETTING_KEY));
  // Jev はタイトル生成と同じ入力しか使わないので直列にせず同時に走らせる。
  const jevLabelPromise = isAutoJevEnabled(getSetting(AUTO_JEV_ENABLED_SETTING_KEY))
    ? classifySessionLabelWithJev(
      { prompt, labels },
      { minConfidence: parseAutoJevMinConfidence(getSetting(AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY)) },
    )
    : Promise.resolve(undefined);
  jevLabelPromise.catch(() => undefined);

  const generated = await generateDirectTextWithFallbackResult({
    candidates,
    accountId: task.accountId,
    ...(task.accountIdExplicit ? { accountIdExplicit: true } : {}),
    system: titleSystemInstruction(labels),
    prompt,
    maxTokens: 120,
    temperature: 0.1,
    timeoutMs: 60_000,
  });
  const { title, labelName } = splitTitleAndLabel(generated.text);
  if (!title) throw new DirectGenerationError("タイトルの応答が空です");

  // タイトルはJevを待たず即時保存。LLM行→ルールを暫定値として先に反映する。
  const immediateLabel = labels.length < 2
    ? undefined
    : labelIdByName(labels, labelName) ?? matchSessionLabelByRule(prompt, labels);
  const updated = patchTask(taskId, { title, ...(immediateLabel ? { label: immediateLabel } : {}) });
  if (!updated) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });

  // Jevが返れば暫定値を上書きする。失敗時は既存値を維持して未処理rejectionを出さない。
  void jevLabelPromise.then((jevLabel) => {
    if (!jevLabel) return;
    patchTask(taskId, { label: jevLabel });
  }).catch(() => undefined);

  return {
    title,
    ...(immediateLabel ? { label: immediateLabel } : {}),
    task: updated,
    model: generated.model,
  };
}
