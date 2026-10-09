import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";

/** Engine metadata/query is not audio. Bound it before JSON parsing or forwarding. */
export const TTS_MAX_ENGINE_JSON_BYTES = 8 * 1024 * 1024;
export async function readTtsEngineText(response: Response): Promise<string> {
  assertConfigurationOwner();
  const tooLarge = () => new Error("TTS engine metadata is too large");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TTS_MAX_ENGINE_JSON_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TTS_MAX_ENGINE_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}
