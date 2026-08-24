import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { getSetting } from "@/lib/pi/web-settings";
import {
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";
import { generateDirectText, parseDirectModel, parseDirectModelKey } from "@/lib/direct-generation";
import { readSessionConversation } from "@/lib/direct-session";
import {
  formatConversationForPrompt,
  NEXT_ACTION_SYSTEM_INSTRUCTION,
  normalizeSuggestion,
  parseSuggestions,
  sanitizePreviousSuggestions,
} from "@/lib/direct-generation-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_CHARS = 80_000;

function errorResponse(error: unknown): NextResponse {
  const status =
    typeof error === "object" && error && "status" in error && typeof error.status === "number"
      ? error.status
      : 502;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "次の一手の生成に失敗しました" },
    { status },
  );
}

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
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });

  const previousSuggestions = sanitizePreviousSuggestions(body.previousSuggestions);
  const prompt = formatConversationForPrompt(
    readSessionConversation(task.sessionFile),
    previousSuggestions,
  );
  if (!prompt) {
    return NextResponse.json({ error: "会話に提案可能な内容がありません" }, { status: 400 });
  }
  const configuredModel = parseDirectModelKey(getSetting(GENERATION_MODEL_SETTING_KEY));
  const model =
    configuredModel ??
    parseDirectModel(body.model) ??
    parseDirectModel({ providerID: task.providerID, modelID: task.modelID });
  if (!model) return NextResponse.json({ error: "生成モデルが設定されていません" }, { status: 400 });
  const effort = configuredModel
    ? getSetting(GENERATION_MODEL_EFFORT_SETTING_KEY) || undefined
    : undefined;

  try {
    const suggestion = normalizeSuggestion(
      await generateDirectText({
        model,
        system: NEXT_ACTION_SYSTEM_INSTRUCTION,
        prompt,
        maxTokens: 180,
        temperature: 0.2,
        effort,
        timeoutMs: 60_000,
      }),
    );
    const suggestions = parseSuggestions({ suggestion });
    if (suggestions.length === 0) return errorResponse(new Error("提案の応答が空です"));
    return NextResponse.json({ suggestion: suggestions[0], suggestions, source: "direct" });
  } catch (error) {
    return errorResponse(error);
  }
}
