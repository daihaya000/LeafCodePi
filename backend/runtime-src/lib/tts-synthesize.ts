import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readTtsEngineText } from "./tts-engine-body";
/**
 * サーバー側のTTS合成。設定（tts.json）のエンジンで音声を作り、ブラウザ再生用に返す。
 * エンジン判定・リクエスト形式は extensions/leafcode-tts/index.ts と合わせる（あちらがCLI側の正本）。
 */

export class TtsSynthesizeError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function httpPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

function isVoicevoxEngineUrl(url: string): boolean {
  const path = httpPath(url).toLowerCase();
  if (path.includes("/v1/audio/speech") || path.includes("/v1/tts") || path.endsWith("/tts")) return false;
  return path === "/";
}

function buildBody(url: string, text: string, voice: string): string {
  const lower = httpPath(url).toLowerCase();
  if (lower.includes("/v1/audio/speech")) {
    return JSON.stringify({ model: "tts-1", input: text, voice: voice || "alloy", response_format: "wav" });
  }
  if (lower.includes("/v1/tts")) {
    const body: Record<string, string> = { text, language: "Japanese" };
    if (voice) {
      body.speaker = voice;
      body.voice = voice;
    }
    return JSON.stringify(body);
  }
  return JSON.stringify(voice ? { text, voice } : { text });
}

/** A hung engine must not pin a Backend worker; the signal also covers reading the body. */
export const TTS_SYNTHESIZE_TIMEOUT_MS = 60_000;
/** Upper bound for one synthesized clip held in memory. */
export const TTS_MAX_AUDIO_BYTES = 64 * 1024 * 1024;

const timeoutSignal = () => AbortSignal.timeout(TTS_SYNTHESIZE_TIMEOUT_MS);

async function readAudio(res: Response): Promise<{ audio: Buffer; contentType: string }> {
  if (!res.ok) throw new TtsSynthesizeError(`合成エンジンが ${res.status} を返しました`);
  const type = res.headers.get("content-type")?.split(";")[0]?.trim();
  const contentType = type && (type.startsWith("audio/") || type === "application/octet-stream") ? type : "audio/wav";
  const tooLarge = () => new TtsSynthesizeError("合成結果が大きすぎます");
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TTS_MAX_AUDIO_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = res.body?.getReader();
  if (!reader) return { audio: Buffer.alloc(0), contentType };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TTS_MAX_AUDIO_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TtsSynthesizeError) throw error;
    throw new TtsSynthesizeError("合成エンジンの応答を読み取れませんでした（タイムアウト？）");
  }
  return { audio: Buffer.concat(chunks), contentType };
}

/** AivisSpeech / VOICEVOX エンジン: audio_query → synthesis。voice は style id。 */
async function synthesizeVoicevox(baseUrl: string, text: string, voice: string, onStart: () => void): Promise<Response> {
  const speaker = voice.replace(/[^0-9]/g, "") || "1";
  const root = baseUrl.replace(/\/+$/, "");
  let queryRes: Response;
  try {
    onStart();
    queryRes = await fetch(`${root}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, {
      method: "POST",
      redirect: "error",
      signal: timeoutSignal(),
    });
  } catch {
    throw new TtsSynthesizeError("合成エンジンに接続できません（停止中？）");
  }
  if (!queryRes.ok) throw new TtsSynthesizeError(`audio_query が ${queryRes.status} を返しました`);
  let synthRes: Response;
  try {
    synthRes = await fetch(`${root}/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await readTtsEngineText(queryRes),
      redirect: "error",
      signal: timeoutSignal(),
    });
  } catch {
    throw new TtsSynthesizeError("合成エンジンに接続できません（停止中？）");
  }
  return synthRes;
}

export async function openTtsEngineAudio(text: string, url: string, voice: string, options: { onStart?: () => void } = {}): Promise<Response> {
  assertConfigurationOwner();
  const clean = text.trim();
  if (!clean) throw new TtsSynthesizeError("読み上げる文章が空です", 400);
  if (!url.trim()) throw new TtsSynthesizeError("合成エンジンが未設定です（設定→読み上げで AivisSpeech または HTTP URL を指定）", 400);
  if (isVoicevoxEngineUrl(url)) return synthesizeVoicevox(url, clean, voice.trim(), options.onStart ?? (() => {}));
  let res: Response;
  try {
    options.onStart?.();
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buildBody(url, clean, voice.trim()),
      redirect: "error",
      signal: timeoutSignal(),
    });
  } catch {
    throw new TtsSynthesizeError("合成エンジンに接続できません（停止中？）");
  }
  return res;
}

/** Buffered compatibility helper for non-HTTP callers; public synthesis uses openTtsEngineAudio. */
export async function synthesizeTts(text: string, url: string, voice: string, options: { onStart?: () => void } = {}): Promise<{ audio: Buffer; contentType: string }> {
  return readAudio(await openTtsEngineAudio(text, url, voice, options));
}
