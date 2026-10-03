import { peerAuthService } from "@/lib/peer-auth/runtime";
import { readBoundedJson, toNextResponse } from "@/lib/peer-auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Peer-facing CodexBar usage; the bearer grant scopes both the account and returned providers. */
export async function POST(request: Request) {
  const body = await readBoundedJson(request);
  const result = await peerAuthService().usage({
    authorization: request.headers.get("authorization"),
    body: body === undefined ? null : body,
  });
  return toNextResponse(result);
}
