import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { publicServiceBusinessBody } from "@shared/service-business-contract.mjs";
import { resolveHostControlUrl, isLoopbackControlUrl } from "./host-control";

/** Fixed Host command. Caller URLs, model choices and credentials are never consumed. */
export async function translateReasoningAtHost(texts: string[]): Promise<Record<string, unknown>> {
  assertConfigurationOwner();
  const base = new URL(resolveHostControlUrl());
  if (!isLoopbackControlUrl(base.href) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Invalid control endpoint");
  const signal = AbortSignal.timeout(65_000);
  const response = await fetch(new URL("/translation/translate", base), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }), cache: "no-store", redirect: "error", signal,
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Translation unavailable"); }
  const limit = 256 * 1024;
  if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel(); throw new Error("Translation response too large"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Translation deadline"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    for (;;) {
      const item = await Promise.race([reader.read(), stopped]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new Error("Translation response too large");
      chunks.push(item.value);
    }
    const bytes = Buffer.concat(chunks);
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const result = publicServiceBusinessBody("translation/reasoning", raw, 200);
    if (!result || (result.translations as string[]).length !== texts.length) throw new Error("Malformed translation response");
    // A Host response cannot forge a Backend command acknowledgement.
    delete result.operation;
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
