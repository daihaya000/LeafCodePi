import { NextResponse } from "next/server";
import type { PeerServiceResponse } from "@backend-core/peer-auth-serve.mjs";

/** Peer auth requests are small; anything larger is not a peer request. */
export const PEER_BODY_MAX_BYTES = 4096;

export function toNextResponse(result: PeerServiceResponse): NextResponse {
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

/** Reads a bounded JSON body. Returns `undefined` for oversize, empty or malformed input. */
export async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PEER_BODY_MAX_BYTES) return undefined;
  try {
    const reader = request.body?.getReader();
    if (!reader) return undefined;
    // Stop reading as soon as the cap is exceeded so a missing/forged Content-Length cannot buffer a huge body.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PEER_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    if (total === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
