import { getTask, patchTask } from "@/lib/store";
import { getSetting } from "@/lib/pi/web-settings";
import {
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";
import {
  DirectGenerationError,
  generateDirectText,
  parseDirectModel,
  parseDirectModelKey,
  type DirectModel,
} from "@/lib/direct-generation";
import { readSessionConversation } from "@/lib/direct-session";
import { formatTranscriptForTitle, sanitizeTitle } from "@/lib/direct-generation-text";

const TITLE_SYSTEM_INSTRUCTION =
  "会話を要約する簡潔な日本語タイトルを1件だけ生成してください。タイトルのみを返し、説明、引用符、見出し、改行は不要です。";

export async function refreshTaskTitleDirect(
  taskId: string,
  requestedModel?: DirectModel,
): Promise<{ title: string; task: ReturnType<typeof patchTask> }> {
  const task = getTask(taskId);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const conversation = readSessionConversation(task.sessionFile);
  const prompt = formatTranscriptForTitle(conversation);
  if (!prompt) throw new DirectGenerationError("タイトルを生成できる会話がありません", 422);

  const configuredModel = parseDirectModelKey(getSetting(GENERATION_MODEL_SETTING_KEY));
  const model =
    configuredModel ??
    requestedModel ??
    parseDirectModel({ providerID: task.providerID, modelID: task.modelID });
  if (!model) throw new DirectGenerationError("生成モデルが設定されていません", 400);
  const effort = configuredModel
    ? getSetting(GENERATION_MODEL_EFFORT_SETTING_KEY) || undefined
    : undefined;

  const title = sanitizeTitle(
    await generateDirectText({
      model,
      system: TITLE_SYSTEM_INSTRUCTION,
      prompt,
      maxTokens: 80,
      temperature: 0.1,
      effort,
      timeoutMs: 60_000,
    }),
  );
  if (!title) throw new DirectGenerationError("タイトルの応答が空です");
  const updated = patchTask(taskId, { title });
  if (!updated) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  return { title, task: updated };
}
