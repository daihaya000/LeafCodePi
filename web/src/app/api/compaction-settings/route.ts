import { NextRequest, NextResponse } from "next/server";
import {
  getCompactionSettings,
  jsonError,
  setCompactionEnabled,
} from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ settings: await getCompactionSettings() });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled（boolean）が必要です" }, { status: 400 });
    }
    return NextResponse.json({ settings: await setCompactionEnabled(body.enabled) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
