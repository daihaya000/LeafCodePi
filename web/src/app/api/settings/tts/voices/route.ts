import { NextResponse } from "next/server";
import { readTtsConfig } from "@/lib/tts-config";
import {
  detectTtsBackend,
  normalizeTtsUrl,
  parseAivisSpeakers,
  type TtsVoicesDto,
} from "@/lib/tts-backends";

const FETCH_TIMEOUT_MS = 2500;

/** Return the installed AivisSpeech styles without exposing the engine's raw metadata. */
export async function GET() {
  const config = readTtsConfig();
  if (detectTtsBackend(config.url) !== "aivis") {
    return NextResponse.json<TtsVoicesDto>({ voices: [] });
  }

  const url = `${normalizeTtsUrl(config.url)}/speakers`;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return NextResponse.json({ error: "AivisSpeechのモデル一覧を取得できません" }, { status: 502 });
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      return NextResponse.json({ error: "AivisSpeechのモデル一覧が不正です" }, { status: 502 });
    }
    return NextResponse.json<TtsVoicesDto>({ voices: parseAivisSpeakers(payload) });
  } catch {
    return NextResponse.json({ error: "AivisSpeechに接続できません" }, { status: 502 });
  }
}
