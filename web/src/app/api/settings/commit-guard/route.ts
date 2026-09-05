import { NextRequest, NextResponse } from "next/server";
import {
  readCommitGuardEnabled,
  writeCommitGuardEnabled,
} from "@/lib/commit-guard-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dto(enabled = readCommitGuardEnabled()) {
  return { enabled };
}

export async function GET() {
  return NextResponse.json(dto());
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
  }
  return NextResponse.json(dto(writeCommitGuardEnabled(body.enabled)));
}
