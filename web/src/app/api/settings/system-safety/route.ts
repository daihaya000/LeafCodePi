import { NextRequest, NextResponse } from "next/server";
import {
  readSystemSafetyLevel,
  writeSystemSafetyEnabled,
  writeSystemSafetyLevel,
} from "@/lib/permission-gate-config";
import { isSystemSafetyLevel, systemSafetyEnabled } from "@/lib/system-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dto(level = readSystemSafetyLevel()) {
  return {
    level,
    systemSafety: systemSafetyEnabled(level),
  };
}

export async function GET() {
  return NextResponse.json(dto());
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    level?: unknown;
    systemSafety?: unknown;
  } | null;

  if (isSystemSafetyLevel(body?.level)) {
    return NextResponse.json(dto(writeSystemSafetyLevel(body.level)));
  }
  if (typeof body?.systemSafety === "boolean") {
    writeSystemSafetyEnabled(body.systemSafety);
    return NextResponse.json(dto());
  }
  return NextResponse.json(
    { error: "level（off|low|standard|strict）または systemSafety（boolean）が必要です" },
    { status: 400 },
  );
}
