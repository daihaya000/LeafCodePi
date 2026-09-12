import { NextRequest, NextResponse } from "next/server";
import { readTtsConfig } from "@/lib/tts-config";
import { synthesizeTts, TtsSynthesizeError } from "@/lib/tts-synthesize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 本文は最大2000文字。読み上げチャンクは90文字程度なので十分な上限。 */
const MAX_TEXT = 2000;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text は必須です" }, { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: `text は${MAX_TEXT}文字以内です` }, { status: 400 });
  }
  const config = readTtsConfig();
  // 全体スイッチはCLIとブラウザの両方のマスター。タスク側OFFと合わせてANDで判定する。
  if (!config.enabled) {
    return NextResponse.json({ error: "読み上げ全体が無効です（設定→読み上げで有効に）" }, { status: 400 });
  }
  try {
    const { audio, contentType } = await synthesizeTts(text, config.url, config.voice);
    // ponytail: 音声バイト列をそのまま返す。キャッシュは置かない（短文・低頻度のため）。
    return new NextResponse(new Uint8Array(audio), { headers: { "content-type": contentType } });
  } catch (error) {
    if (error instanceof TtsSynthesizeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "合成に失敗しました" }, { status: 502 });
  }
}
