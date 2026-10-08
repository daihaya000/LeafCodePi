import { peerAuthService } from "@/lib/peer-auth/runtime";
import { toNextResponse } from "@/lib/peer-auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Peer-facing metadata list. Public to the WebUI cookie layer; the bearer peer token is checked here. */
export async function GET(request: Request) {
  const result = await peerAuthService().list({ authorization: request.headers.get("authorization") });
  return toNextResponse(result);
}
