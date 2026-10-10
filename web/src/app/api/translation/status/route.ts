import { hostTranslationPath, resolveHostControlUrl } from "@/lib/host-http-client";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const response = await fetch(`${resolveHostControlUrl()}${hostTranslationPath("status")}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404) {
      return Response.json({ ok: false, state: "host-outdated" }, { status: 503 });
    }
    return Response.json(body, { status: response.ok ? 200 : 503 });
  } catch {
    return Response.json({ ok: false, state: "unavailable" }, { status: 503 });
  }
}
