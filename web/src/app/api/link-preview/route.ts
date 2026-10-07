import { NextResponse } from "next/server";
import { getLinkPreview } from "@/lib/link-preview";
import { normalizeLinkUrl } from "@/lib/link-preview-shared";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

/** POST keeps pasted URLs (including query tokens) out of API/access-log paths. */
export async function POST(request: Request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "JSONでURLを指定してください" }, { status: 415, headers });
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(2000)]);
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: "URLを指定してください" }, { status: 400, headers });
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const item = await Promise.race([reader.read(), stopped]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 32 * 1024) return NextResponse.json({ error: "URLが長すぎます" }, { status: 413, headers });
      chunks.push(item.value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url?: unknown } | null;
    const url = normalizeLinkUrl(payload?.url);
    if (!url) return NextResponse.json({ error: "HTTP/HTTPSのURLを指定してください" }, { status: 400, headers });
    return NextResponse.json(await getLinkPreview(url), { headers });
  } catch {
    return NextResponse.json({ error: "プレビューを取得できません" }, { status: signal.aborted ? 408 : 400, headers });
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
