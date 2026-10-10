
import { hostPiUpdatePath, resolveHostControlUrl } from "@/lib/host-http-client";
import { hostLaunchCheckHint } from "@/lib/host-launch-hints";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PiUpdateMode = "default" | "latest";

const MODES = new Set<PiUpdateMode>(["default", "latest"]);

function unreachableResponse(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof Error
          ? `ホスト制御に接続できません: ${error.message}`
          : "ホスト制御に接続できません",
      hint: hostLaunchCheckHint(),
    },
    { status: 502 },
  );
}

function unsupported(status: number): boolean {
  return status === 404 || status === 501;
}

/** Keep the host's 4xx semantics (e.g. a synchronization already in progress) and map the rest. */
function errorStatus(status: number): number {
  if (unsupported(status)) return 501;
  return status >= 400 && status < 500 ? status : 502;
}

export async function GET() {
  const base = resolveHostControlUrl();
  try {
    const res = await fetch(`${base}${hostPiUpdatePath()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return Response.json(
        {
          error: unsupported(res.status)
            ? "トレイホストがPiアップデート予約に未対応です。ホストを再起動してください"
            : typeof data.error === "string"
              ? data.error
              : `host control failed: ${res.status}`,
        },
        { status: errorStatus(res.status) },
      );
    }
    return Response.json(data, { status: 200 });
  } catch (err) {
    return unreachableResponse(err);
  }
}

export async function POST(req: Request) {
  let mode: PiUpdateMode | null = null;
  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  if (body.mode && MODES.has(body.mode as PiUpdateMode)) {
    mode = body.mode as PiUpdateMode;
  }
  if (!mode) {
    return Response.json({ error: "mode must be default or latest" }, { status: 400 });
  }

  const base = resolveHostControlUrl();
  try {
    const res = await fetch(`${base}${hostPiUpdatePath()}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && res.status !== 202) {
      return Response.json(
        {
          error: unsupported(res.status)
            ? "トレイホストがPiアップデート予約に未対応です。ホストを再起動してください"
            : typeof data.error === "string"
              ? data.error
              : `host control failed: ${res.status}`,
        },
        { status: errorStatus(res.status) },
      );
    }
    return Response.json({ ok: true, mode, ...data }, { status: 202 });
  } catch (err) {
    return unreachableResponse(err);
  }
}
