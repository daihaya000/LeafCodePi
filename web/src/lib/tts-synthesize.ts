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

async function readAudio(res: Response): Promise<{ audio: Buffer; contentType: string }> {
  if (!res.ok) throw new TtsSynthesizeError(`合成エンジンが ${res.status} を返しました`);
  const type = res.headers.get("content-type")?.split(";")[0]?.trim();
  const contentType = type && (type.startsWith("audio/") || type === "application/octet-stream") ? type : "audio/wav";
  return { audio: Buffer.from(await res.arrayBuffer()), contentType };
}

/** AivisSpeech / VOICEVOX エンジン: audio_query → synthesis。voice は style id。 */
async function synthesizeVoicevox(baseUrl: string, text: string, voice: string): Promise<{ audio: Buffer; contentType: string }> {
  const speaker = voice.replace(/[^0-9]/g, "") || "1";
  const root = baseUrl.replace(/\/+$/, "");
  let queryRes: Response;
  try {
    queryRes = await fetch(`${root}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: "POST" });
  } catch {
    throw new TtsSynthesizeError("合成エンジンに接続できません（停止中？）");
  }
  if (!queryRes.ok) throw new TtsSynthesizeError(`audio_query が ${queryRes.status} を返しました`);
  let synthRes: Response;
  try {
    synthRes = await fetch(`${root}/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await queryRes.text(),
    });
  } catch {
    throw new TtsSynthesizeError("合成エンジンに接続できません（停止中？）");
  }
  return readAudio(synthRes);
}

export async function synthesizeTts(text: string, url: string, voice: string): Promise<{ audio: Buffer; contentType: string }> {
  const clean = text.trim();
  if (!clean) throw new TtsSynthesizeError("読み上げる文章が空です", 400);
  if (!url.trim()) throw new TtsSynthesizeError("合成エンジンが未設定です（設定→読み上げでURLを指定）", 400);
  if (isVoicevoxEngineUrl(url)) return synthesizeVoicevox(url, clean, voice.trim());
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buildBody(url, clean, voice.trim()),
    });
  } catch {
    throw new TtsSynthesizeError("合成エンジンに接続できません（停止中？）");
  }
  return readAudio(res);
}
