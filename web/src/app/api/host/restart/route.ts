import { NextResponse } from "next/server";
import {
  hostRestartPath,
  resolveHostControlUrl,
  type HostRestartTarget,
} from "@/lib/host-http-client";
import { hostLaunchCheckHint } from "@/lib/host-launch-hints";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TARGETS = new Set<HostRestartTarget>(["webui", "backend", "host"]);

export async function POST(req: Request) {
  let target: HostRestartTarget | null = null;
  try {
    const body = (await req.json().catch(() => ({}))) as { target?: string };
    if (body.target && TARGETS.has(body.target as HostRestartTarget)) {
      target = body.target as HostRestartTarget;
    } else {
      return NextResponse.json(
        { error: "target must be webui, backend or host" },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "target must be webui, backend or host" },
      { status: 400 },
    );
  }

  const base = resolveHostControlUrl();
  const path = hostRestartPath(target);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && res.status !== 202) {
      // Preserve operator-facing refusals (Goal Loop 409, capability 501) instead of
      // flattening every failure into a generic 502 gateway error.
      const status = res.status === 409 || res.status === 501 || res.status === 400
        ? res.status
        : 502;
      return NextResponse.json(
        {
          error:
            typeof data.error === "string"
              ? data.error
              : res.status === 501 && target === "backend"
                ? "トレイホストがバックエンド再起動に未対応です。トレイメニューからホストを再起動してください"
                : `host control failed: ${res.status}`,
          target,
          ...(data.blocked === true ? { blocked: true } : {}),
        },
        { status },
      );
    }
    return NextResponse.json(
      { ok: true, target, accepted: true, ...data },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `ホスト制御に接続できません: ${err.message}`
            : "ホスト制御に接続できません",
        target,
        hint: hostLaunchCheckHint(),
      },
      { status: 502 },
    );
  }
}
