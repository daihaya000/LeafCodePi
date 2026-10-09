import { resolveHostControlUrl } from "@/lib/host-http-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Protected by the same WebUI auth proxy as the other Host control routes. */
export async function POST() {
  try {
    const response = await fetch(`${resolveHostControlUrl()}/host/activity`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(3000),
    });
    return new Response(null, { status: response.ok ? 204 : 502 });
  } catch {
    return new Response(null, { status: 502 });
  }
}
