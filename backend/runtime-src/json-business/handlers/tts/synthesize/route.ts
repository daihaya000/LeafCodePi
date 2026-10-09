import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse, isConfigurationRequestAuthorized as isWebUiRequestAuthorized } from "../../../../configuration/http";
import { getBot } from "@/lib/bots";

import { isSafeUnauthenticatedTtsUrl, readTtsConfig } from "@/lib/tts-config";
import { openTtsEngineAudio, TtsSynthesizeError } from "@/lib/tts-synthesize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 本文は最大2000文字。読み上げチャンクは90文字程度なので十分な上限。 */
const MAX_TEXT = 2000;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  assertConfigurationOwner();
  const body = (await req.json().catch(() => null)) as { text?: unknown; botId?: unknown } | null;
  const botId = typeof body?.botId === "string" ? body.botId.trim() : "";
  if (body?.botId !== undefined && (typeof body.botId !== "string" || !botId)) {
    return NextResponse.json({ error: "botId が不正です" }, { status: 400 });
  }
  if (botId.length > 128 || /[\\/\x00-\x1f\x7f]/.test(botId) || botId.includes("..")) return NextResponse.json({ error: "botId が不正です" }, { status: 400 });
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text は必須です" }, { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: `text は${MAX_TEXT}文字以内です` }, { status: 400 });
  }
  const config = readTtsConfig();
  if (config.url && !isSafeUnauthenticatedTtsUrl(config.url) && !isWebUiRequestAuthorized(req)) return unauthorized();
  const bot = botId ? getBot(botId) : undefined;
  if (botId && !bot) {
    return NextResponse.json({ error: "ボットが見つかりません" }, { status: 404 });
  }
  // 全体スイッチはCLIとブラウザの両方のマスター。タスク側OFFと合わせてANDで判定する。
  if (!config.enabled) {
    return NextResponse.json({ error: "読み上げ全体が無効です（設定→読み上げで有効に）" }, { status: 400 });
  }
  let attempted = false;
  try {
    const response = await openTtsEngineAudio(text, config.url, bot?.ttsVoice || config.voice, { onStart: () => { attempted = true; } });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new TtsSynthesizeError("合成エンジンの結果を確認できません", 502); }
    return response;
  } catch (error) {
    if (attempted && error instanceof TtsSynthesizeError && error.status < 500) return NextResponse.json({ error: "音声合成の結果を確認できません" }, { status: 503 });
    if (error instanceof TtsSynthesizeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "合成に失敗しました" }, { status: 502 });
  }
}
