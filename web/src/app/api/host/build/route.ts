import { NextResponse } from "next/server";
import { resolveHostControlUrl } from "@/lib/host-control";
import { hostLaunchCheckHint } from "@/lib/host-launch-hints";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Force a production build before the WebUI comes back. The rebuild runs from
 * the tray host (stop → build → start) because `next build` replaces the .next
 * the running server is serving.
 */
export async function POST() {
  const base = resolveHostControlUrl();
  try {
    const res = await fetch(`${base}/build/webui`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && res.status !== 202) {
      return NextResponse.json(
        {
          error:
            typeof data.error === "string"
              ? data.error
              : `host control failed: ${res.status}`,
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, accepted: true, ...data }, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `ホスト制御に接続できません: ${err.message}`
            : "ホスト制御に接続できません",
        hint: hostLaunchCheckHint(),
      },
      { status: 502 },
    );
  }
}
