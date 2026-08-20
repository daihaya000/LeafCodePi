import { NextResponse } from "next/server";
import {
  hostRestartPath,
  resolveHostControlUrl,
  type HostRestartTarget,
} from "@/lib/host-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TARGETS = new Set<HostRestartTarget>(["webui", "host"]);

export async function POST(req: Request) {
  let target: HostRestartTarget | null = null;
  try {
    const body = (await req.json().catch(() => ({}))) as { target?: string };
    if (body.target && TARGETS.has(body.target as HostRestartTarget)) {
      target = body.target as HostRestartTarget;
    } else {
      return NextResponse.json(
        { error: "target must be webui or host" },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "target must be webui or host" },
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
      return NextResponse.json(
        {
          error:
            typeof data.error === "string"
              ? data.error
              : `host control failed: ${res.status}`,
          target,
        },
        { status: 502 },
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
        hint: "start.bat（トレイホスト）経由で起動しているか確認してください",
      },
      { status: 502 },
    );
  }
}
