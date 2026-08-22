import { NextRequest, NextResponse } from "next/server";
import {
  readHangTimeoutSettingMs,
  writeHangTimeoutSettingMs,
} from "@/lib/pi/hang-settings";
import { clampHangTimeoutMs } from "@/lib/hang-timeout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ timeoutMs: readHangTimeoutSettingMs() });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { timeoutMs?: unknown } | null;
  if (typeof body?.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs)) {
    return NextResponse.json({ error: "timeoutMs（number）が必要です" }, { status: 400 });
  }
  const timeoutMs = writeHangTimeoutSettingMs(clampHangTimeoutMs(body.timeoutMs));
  return NextResponse.json({ timeoutMs });
}
