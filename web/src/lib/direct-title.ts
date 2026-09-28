import { getTask, listTasks, patchTask } from "@/lib/store";
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
  buildLabelTranscript,
  formatTranscriptForLabel,
  formatTranscriptForTitle,
  formatWorkSummaryForTitle,
  LABEL_TRANSCRIPT_MAX_CHARS,
  labelNameFromReply,
  splitTitleAndLabel,
  type ConversationMessage,
} from "@/lib/direct-generation-text";
import { classifySessionLabelWithJev, matchSessionLabelByRule } from "@/lib/auto-jev";
import { emitTaskChanged, hasUsableJevModelConfigured } from "@/lib/pi/harness";
import { stripPromptMarkers } from "@/lib/pi/messages";
import {
  AUTO_JEV_ENABLED_SETTING_KEY,
  AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY,
  isAutoJevEnabled,
  parseAutoJevMinConfidence,
} from "@/lib/auto-jev-settings";
import {
  isSessionLabelJevEnabled,
  resolveSessionLabels,
  SESSION_LABEL_JEV_SETTING_KEY,
  SESSION_LABELS_SETTING_KEY,
  type SessionLabel,
} from "@/lib/session-label-settings";
import type { TaskSummary } from "@/lib/types";

/**
 * Label jobs run in the background, so a cold Jev catalog may take longer than the
 * 2s routing bound. That bound used to skip Jev right at session creation.
 */
const LABEL_JEV_CATALOG_WAIT_MS = 15_000;

/**
 * Jev labelling is on and a Jev model can be called. Settings are checked first so the Jev
 * catalog is not consulted when Jev is off. Without Jev, labels piggyback on title generation
 * (the settings screen promises no extra request), so background jobs only apply the rule.
 */
async function shouldUseJevForLabels(): Promise<boolean> {
  return isAutoJevEnabled(getSetting(AUTO_JEV_ENABLED_SETTING_KEY)) &&
    isSessionLabelJevEnabled(getSetting(SESSION_LABEL_JEV_SETTING_KEY)) &&
    await hasUsableJevModelConfigured({ waitMs: LABEL_JEV_CATALOG_WAIT_MS });
}

function currentLabels(): SessionLabel[] {
  // ponytail: サーバは設定のミラーを読む。CRUD 直後の書き込みが未達なら1回だけ古い定義で分類する。
  return resolveSessionLabels(getSetting(SESSION_LABELS_SETTING_KEY));
}

/** A label whose definition was deleted also renders as "-", so it counts as missing. */
function hasKnownLabel(task: TaskSummary, labels: readonly SessionLabel[]): boolean {
  return Boolean(task.label) && labels.some((label) => label.id === task.label);
}

function classifyWithJev(
  text: string,
  labels: readonly SessionLabel[],
): Promise<string | undefined> {
  return classifySessionLabelWithJev(
    { prompt: text, labels },
    { minConfidence: parseAutoJevMinConfidence(getSetting(AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY)) },
  );
}

async function jevLabelFor(
  text: string,
  labels: readonly SessionLabel[],
): Promise<string | undefined> {
  if (labels.length === 0 || !await shouldUseJevForLabels()) return undefined;
  return classifyWithJev(text, labels);
}

const TITLE_SYSTEM_INSTRUCTION =
  "会話を要約する簡潔な日本語タイトルを1件だけ生成してください。タイトルのみを返し、説明、引用符、見出し、改行は不要です。";

/** The label line rides along with the title response, so it costs no extra request. */
function titleSystemInstruction(labels: readonly SessionLabel[]): string {
  if (labels.length === 0) return TITLE_SYSTEM_INSTRUCTION;
  return [
    "1行目に会話を要約する簡潔な日本語タイトルを1件だけ出力してください。",
    `2行目に「ラベル: <名前>」の形式で、次のいずれか1つだけを出力してください: ${labels.map((label) => label.name).join(" / ")}`,
    "該当するものがなければ2行目を省略してください。",
    "説明、引用符、見出し、その他の行は不要です。",
  ].join("\n");
}

function labelSystemInstruction(labels: readonly SessionLabel[]): string {
  return [
    "コーディングセッションの記録を読み、内容に最も合うラベルを次の候補から必ず1つ選んでください。",
    ...labels.map((label) => `- ${label.name}: ${label.hint || label.name}`),
    "選んだラベル名だけを1行で出力してください。説明、引用符、その他の文字は不要です。",
  ].join("\n");
}

function labelIdByName(
  labels: readonly SessionLabel[],
  name: string | null,
): string | undefined {
  if (!name) return undefined;
  return labels.find((label) => label.name === name)?.id;
}

function generationCandidates(task: TaskSummary, requestedModel?: DirectModel) {
  const configuredModel = parseDirectModelKey(getSetting(GENERATION_MODEL_SETTING_KEY));
  const primaryModel =
    configuredModel ??
    requestedModel ??
    parseDirectModel({ providerID: task.providerID, modelID: task.modelID });
  const fallbackModel = parseDirectModelKey(getSetting(GENERATION_FALLBACK_MODEL_SETTING_KEY));
  return buildDirectGenerationCandidates({
    primary: primaryModel,
    primaryEffort: configuredModel
      ? getSetting(GENERATION_MODEL_EFFORT_SETTING_KEY) || undefined
      : undefined,
    fallback: fallbackModel,
    fallbackEffort: fallbackModel
      ? getSetting(GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY) || undefined
      : undefined,
  });
}

/** Last resort when Jev and the keyword rule both miss: one short request to the title model. */
async function modelLabelFor(
  task: TaskSummary,
  transcript: string,
  labels: readonly SessionLabel[],
): Promise<string | undefined> {
  const candidates = generationCandidates(task);
  const prompt = formatTranscriptForLabel(transcript);
  if (labels.length === 0 || candidates.length === 0 || !prompt) return undefined;
  try {
    const generated = await generateDirectTextWithFallbackResult({
      candidates,
      accountId: task.accountId,
      ...(task.accountIdExplicit ? { accountIdExplicit: true } : {}),
      system: labelSystemInstruction(labels),
      prompt,
      maxTokens: 120,
      temperature: 0.1,
      timeoutMs: 30_000,
    });
    return labelIdByName(labels, labelNameFromReply(generated.text, labels.map((label) => label.name)));
  } catch {
    return undefined;
  }
}

/** transcript feeds Jev and the model; ruleText is what the user asked for. */
type LabelSource = { transcript: string; ruleText: string };

function labelSourceFor(
  task: TaskSummary,
  conversation: readonly ConversationMessage[] = readSessionConversation(task.sessionFile),
): LabelSource | null {
  if (conversation.length > 0) {
    const transcript = buildLabelTranscript(conversation);
    const userText = conversation
      .filter((message) => message.role === "user")
      .map((message) => message.text)
      .join("\n\n");
    return { transcript, ruleText: userText || transcript };
  }
  // 圧縮直後・履歴退避などで会話が取れない時は ToDo と作業ログ、最後はタイトルで判定する
  const summary = readSessionWorkSummary(task.sessionFile);
  const work = [...summary.todos.map((todo) => todo.content), ...summary.activity]
    .join("\n")
    .slice(0, LABEL_TRANSCRIPT_MAX_CHARS);
  if (work.trim()) return { transcript: work, ruleText: work };
  const title = task.title.trim();
  return title ? { transcript: `User: ${title}`, ruleText: title } : null;
}

type LabelJobState = {
  /** One running classification per task; see runLabelJob. */
  jobs: Map<string, Promise<string | undefined>>;
  /** Transcript on which Jev and the title model last found nothing, per task. */
  missed: Map<string, string>;
};

const LABEL_JOB_STATE_KEY = Symbol.for("leafcode-pi.session-label-job-state");

function labelJobState(): LabelJobState {
  const holder = globalThis as typeof globalThis & { [LABEL_JOB_STATE_KEY]?: LabelJobState };
  return (holder[LABEL_JOB_STATE_KEY] ??= { jobs: new Map(), missed: new Map() });
}

/**
 * Jev, then the keyword rule, then one short request to the title model; without Jev only
 * the rule runs (see shouldUseJevForLabels). A transcript on which Jev and the model already
 * missed is not sent again: once a session outgrows the head-first window, every later turn
 * would repeat the same failing requests.
 */
async function classifyTaskLabel(
  task: TaskSummary,
  labels: readonly SessionLabel[],
  source: LabelSource,
): Promise<string | undefined> {
  const { missed } = labelJobState();
  const byRule = () => matchSessionLabelByRule(source.ruleText, labels);
  if (missed.get(task.id) === source.transcript || !await shouldUseJevForLabels()) return byRule();
  const label = await classifyWithJev(source.transcript, labels) ??
    byRule() ??
    await modelLabelFor(task, source.transcript, labels);
  if (label) missed.delete(task.id);
  else missed.set(task.id, source.transcript);
  return label;
}

function applyLabel(
  taskId: string,
  label: string,
  keepKnownFrom?: readonly SessionLabel[],
): string | undefined {
  const current = getTask(taskId);
  if (!current) return undefined;
  // Another writer (e.g. a manual title refresh) may have labelled the task meanwhile.
  if (keepKnownFrom && hasKnownLabel(current, keepKnownFrom)) return current.label;
  // A label is metadata, not activity: keep updatedAt (sidebar order, unread, auto-archive).
  if (current.label !== label && patchTask(taskId, { label }, { preserveUpdatedAt: true })) {
    // Push the late label to open panes; otherwise it waits for the next lifecycle snapshot.
    emitTaskChanged(taskId, "label_changed");
  }
  return label;
}

/**
 * One label job per task at a time. Creation, turn end, startup backfill and the pane's
 * request share a running job; when it finds nothing the caller runs its own, because it may
 * see more of the session (the creation job only knows the first prompt).
 */
async function runLabelJob(
  taskId: string,
  job: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const { jobs } = labelJobState();
  const running = jobs.get(taskId);
  if (running) return (await running) ?? runLabelJob(taskId, job);
  const promise = job()
    .catch(() => undefined)
    .finally(() => {
      if (jobs.get(taskId) === promise) jobs.delete(taskId);
    });
  jobs.set(taskId, promise);
  return promise;
}

/**
 * Runs right after task creation. The keyword rule already stored its label at insert,
 * Jev may refine it, and the title model only runs when neither produced one.
 */
export function refineInitialTaskLabel(
  taskId: string,
  prompt: string,
): Promise<string | undefined> {
  return runLabelJob(taskId, async () => {
    const labels = currentLabels();
    const text = stripPromptMarkers(prompt).trim();
    const task = getTask(taskId);
    if (!task || labels.length === 0 || !text) return undefined;
    // Without Jev the insert-time keyword label stands (see shouldUseJevForLabels).
    if (!await shouldUseJevForLabels()) return hasKnownLabel(task, labels) ? task.label : undefined;
    const transcript = buildLabelTranscript([{ role: "user", text }]);
    const jevLabel = await classifyWithJev(transcript, labels);
    if (jevLabel) return applyLabel(taskId, jevLabel);
    const latest = getTask(taskId);
    if (!latest || hasKnownLabel(latest, labels)) return latest?.label;
    const modelLabel = await modelLabelFor(latest, transcript, labels);
    if (modelLabel) return applyLabel(taskId, modelLabel, labels);
    labelJobState().missed.set(taskId, transcript);
    return undefined;
  });
}

/** Label a task without a known label; the pane passes the source it already read. */
function labelTaskJob(taskId: string, presetSource?: LabelSource): Promise<string | undefined> {
  return runLabelJob(taskId, async () => {
    const task = getTask(taskId);
    const labels = currentLabels();
    if (!task || labels.length === 0) return undefined;
    if (hasKnownLabel(task, labels)) return task.label;
    const source = presetSource ?? labelSourceFor(task);
    if (!source) return undefined;
    const label = await classifyTaskLabel(task, labels, source);
    return label ? applyLabel(taskId, label, labels) : undefined;
  });
}

/** Used after each settled turn and by the startup backfill. */
export function ensureTaskLabelDirect(taskId: string): Promise<string | undefined> {
  return labelTaskJob(taskId);
}

/**
 * Startup pass for sessions every earlier attempt missed: all of them, newest first, one at a
 * time. Labels keep updatedAt, so this neither reorders the sidebar nor marks sessions unread.
 */
export async function backfillMissingTaskLabels(
  limit = Number.POSITIVE_INFINITY,
): Promise<number> {
  const labels = currentLabels();
  if (labels.length === 0) return 0;
  const pending = listTasks(false, "code")
    .filter((task) => task.sessionFile && !hasKnownLabel(task, labels))
    .slice(0, limit);
  let labelled = 0;
  for (const task of pending) {
    if (await ensureTaskLabelDirect(task.id)) labelled += 1;
  }
  return labelled;
}

/**
 * The pane asks once the first turn is done. It shares the background job and returns an
 * already known label instead of classifying the session a second time.
 */
export async function refreshTaskLabelDirect(
  taskId: string,
): Promise<{ label?: string; task: ReturnType<typeof patchTask> }> {
  const task = getTask(taskId);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const source = labelSourceFor(task);
  if (!source) {
    throw new DirectGenerationError("ラベルを判定できる会話・ToDo・作業ログがありません", 422);
  }
  const label = await labelTaskJob(taskId, source);
  return { ...(label ? { label } : {}), task: getTask(taskId) };
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

  const candidates = generationCandidates(task, requestedModel);
  if (candidates.length === 0) throw new DirectGenerationError("生成モデルが設定されていません", 400);

  const labels = currentLabels();
  const labelSource = labelSourceFor(task, conversation);
  // Jev はタイトル生成と同じ会話を使うので直列にせず同時に走らせる。
  let jevSettled = false;
  let jevLabel: string | undefined;
  const jevLabelPromise = (labelSource ? jevLabelFor(labelSource.transcript, labels) : Promise.resolve(undefined))
    .then((value) => {
      jevSettled = true;
      jevLabel = value;
      if (value) applyLabel(taskId, value);
      return value;
    }).catch(() => {
      jevSettled = true;
      return undefined;
    });

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
  const fallbackLabel =
    labelIdByName(labels, labelName) ??
    (labelSource ? matchSessionLabelByRule(labelSource.ruleText, labels) : undefined);
  // If Jev already settled, preserve its answer; otherwise this is a temporary value.
  const immediateLabel = jevSettled ? jevLabel ?? fallbackLabel : fallbackLabel;
  const updated = patchTask(taskId, { title, ...(immediateLabel ? { label: immediateLabel } : {}) });
  if (!updated) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });

  // Jevが返れば暫定値を上書きする。失敗時は既存値を維持して未処理rejectionを出さない。
  // jevLabelPromise is already handled above; a pending Jev result will patch later.
  void jevLabelPromise;

  return {
    title,
    ...(immediateLabel ? { label: immediateLabel } : {}),
    task: updated,
    model: generated.model,
  };
}
