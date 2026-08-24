import { NextRequest, NextResponse } from "next/server";
import {
  readAutoResumeModeSetting,
  readHangTimeoutSettingMs,
  writeAutoResumeModeSetting,
  writeHangTimeoutSettingMs,
} from "@/lib/pi/hang-settings";
import {
  clampHangTimeoutMs,
  isAutoResumeMode,
} from "@/lib/hang-timeout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    timeoutMs: readHangTimeoutSettingMs(),
    resumeMode: readAutoResumeModeSetting(),
  });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    timeoutMs?: unknown;
    resumeMode?: unknown;
  } | null;
  const timeoutValue = body?.timeoutMs;
  const resumeModeValue = body?.resumeMode;
  if (timeoutValue === undefined && resumeModeValue === undefined) {
    return NextResponse.json({ error: "timeoutMs または resumeMode が必要です" }, { status: 400 });
  }
  if (timeoutValue !== undefined && (typeof timeoutValue !== "number" || !Number.isFinite(timeoutValue))) {
    return NextResponse.json({ error: "timeoutMs（number）が必要です" }, { status: 400 });
  }
  if (resumeModeValue !== undefined && !isAutoResumeMode(resumeModeValue)) {
    return NextResponse.json({ error: "resumeMode が不正です" }, { status: 400 });
  }

  const timeoutMs = timeoutValue === undefined
    ? readHangTimeoutSettingMs()
    : writeHangTimeoutSettingMs(clampHangTimeoutMs(timeoutValue));
  const resumeMode = resumeModeValue === undefined
    ? readAutoResumeModeSetting()
    : writeAutoResumeModeSetting(resumeModeValue);
  return NextResponse.json({ timeoutMs, resumeMode });
}
