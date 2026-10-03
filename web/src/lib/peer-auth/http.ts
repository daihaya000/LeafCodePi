import { NextResponse } from "next/server";
import type { PeerServiceResponse } from "@backend-core/peer-auth-serve.mjs";

/** Resolve requests are tiny ({providerId, accountId}); anything larger is not a peer. */
export const PEER_BODY_MAX_BYTES = 4096;

export function toNextResponse(result: PeerServiceResponse): NextResponse {
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

/** Reads a bounded JSON body. Returns `undefined` for oversize, empty or malformed input. */
export async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PEER_BODY_MAX_BYTES) return undefined;
  try {
    const text = await request.text();
    if (!text || Buffer.byteLength(text, "utf8") > PEER_BODY_MAX_BYTES) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
