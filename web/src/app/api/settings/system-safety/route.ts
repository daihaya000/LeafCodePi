import { NextRequest, NextResponse } from "next/server";
import {
  readSystemSafetyEnabled,
  writeSystemSafetyEnabled,
} from "@/lib/permission-gate-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ systemSafety: readSystemSafetyEnabled() });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    systemSafety?: unknown;
  } | null;
  if (typeof body?.systemSafety !== "boolean") {
    return NextResponse.json({ error: "systemSafety（boolean）が必要です" }, { status: 400 });
  }
  return NextResponse.json({ systemSafety: writeSystemSafetyEnabled(body.systemSafety) });
}
