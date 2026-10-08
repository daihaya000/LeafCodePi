import { peerAuthService } from "@/lib/peer-auth/runtime";
import { readBoundedJson, toNextResponse } from "@/lib/peer-auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Peer-facing credential resolve. Public to the WebUI cookie layer; the bearer peer token is checked here. */
export async function POST(request: Request) {
  // Authentication runs first inside the service; a bad body from an unauthenticated caller is still 401.
  const body = await readBoundedJson(request);
  const result = await peerAuthService().resolve({
    authorization: request.headers.get("authorization"),
    body: body === undefined ? null : body,
  });
  return toNextResponse(result);
}
