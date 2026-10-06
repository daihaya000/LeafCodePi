import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { openTaskLocalMedia, parseMediaRange } from "@/lib/local-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function serve(req: NextRequest, { params }: { params: Promise<{ id: string }> }, head: boolean) {
  const { id } = await params;
  const media = await openTaskLocalMedia(id, req.nextUrl.searchParams.get("path") ?? "");
  if (!media.ok) return new NextResponse(head ? null : JSON.stringify({ error: media.error }), {
    status: media.status, headers: { "content-type": "application/json" },
  });
  // No validators/ETag are emitted: an If-Range conditional cannot be satisfied.
  const rangeHeader = head || req.headers.has("if-range") ? null : req.headers.get("range");
  const range = parseMediaRange(rangeHeader, media.size);
  const headers: Record<string, string> = {
    "content-type": media.mime,
    "content-disposition": "inline",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
  if (!range) {
    await media.file.close();
    return new NextResponse(null, { status: 416, headers: { ...headers, "content-range": `bytes */${media.size}` } });
  }
  headers["content-length"] = String(range.end - range.start + 1);
  if (rangeHeader !== null) headers["content-range"] = `bytes ${range.start}-${range.end}/${media.size}`;
  if (head) {
    await media.file.close();
    return new NextResponse(null, { headers });
  }
  const stream = media.file.createReadStream({ start: range.start, end: range.end, autoClose: true });
  const abort = () => stream.destroy(new Error("Media request aborted"));
  req.signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => req.signal.removeEventListener("abort", abort));
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  if (req.signal.aborted) abort();
  return new NextResponse(body, { status: rangeHeader === null ? 200 : 206, headers });
}
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return serve(req, context, false);
}
export async function HEAD(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return serve(req, context, true);
}
