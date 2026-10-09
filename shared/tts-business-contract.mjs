import { publicTaskOperation } from "./task-collection-contract.mjs";
export const TTS_BUSINESS_ROUTES = Object.freeze({
  "settings/tts/voices": ["GET"], "tts/synthesize": ["POST"],
});
export const TTS_BUSINESS_BODY_LIMIT = 16 * 1024;
export const TTS_AUDIO_LIMIT = 64 * 1024 * 1024;
// Only this private envelope allows base64 overhead; other business responses remain 32 MiB.
export const TTS_WIRE_RESPONSE_LIMIT = 90 * 1024 * 1024;
export function ttsBusinessTarget(route) {
  return Object.hasOwn(TTS_BUSINESS_ROUTES, route) ? { route, params: {} } : null;
}
const record = value => value && typeof value === "object" && !Array.isArray(value);
function audioDto(value) {
  if (!record(value) || typeof value.contentType !== "string" ||
      !(value.contentType === "application/octet-stream" || /^audio\/[A-Za-z0-9.+-]+$/.test(value.contentType))) return null;
  const base64 = value.base64;
  if (typeof base64 !== "string" || base64.length > 4 * Math.ceil(TTS_AUDIO_LIMIT / 3) ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  if (base64.length / 4 * 3 - padding > TTS_AUDIO_LIMIT) return null;
  // Reject noncanonical padding bits without decoding/copying a potentially 64 MiB clip.
  if (padding) {
    const digit = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(base64.at(-padding - 1));
    if (digit < 0 || (digit & (padding === 2 ? 15 : 3)) !== 0) return null;
  }
  return { contentType: value.contentType, base64 };
}
/** Deep public projection, not a provider/URL/config selector. */
export function publicTtsBusinessBody(route, value, status) {
  if (!ttsBusinessTarget(route) || !record(value)) return null;
  let out;
  if (status >= 400) {
    if (typeof value.error !== "string") return null;
    out = { error: value.error };
  } else if (route === "settings/tts/voices") {
    if (!Array.isArray(value.voices)) return null;
    const voices = [];
    for (const voice of value.voices) {
      if (!record(voice) || typeof voice.id !== "string" || !voice.id || typeof voice.label !== "string") return null;
      voices.push({ id: voice.id, label: voice.label });
    }
    out = { voices };
  } else {
    const audio = audioDto(value.audio);
    if (!audio) return null;
    out = { audio };
  }
  if (value.operation !== undefined) {
    const operation = publicTaskOperation(value.operation);
    if (!operation || (status < 400 && operation.execution !== "complete")) return null;
    out.operation = operation;
  }
  return out;
}
