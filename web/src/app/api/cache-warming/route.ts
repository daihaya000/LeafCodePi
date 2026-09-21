import { NextRequest, NextResponse } from "next/server";
import {
  getCacheWarmingMode,
  jsonError,
  setCacheWarmingMode,
} from "@/lib/pi/harness";
import {
  parseCacheWarmingMode,
  type CacheWarmingMode,
} from "@/lib/compaction-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ mode: await getCacheWarmingMode() });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { mode?: unknown } | null;
    const mode = parseCacheWarmingMode(body?.mode);
    if (!mode) {
      return NextResponse.json(
        { error: "mode（off/streaming/idle）が必要です" },
        { status: 400 },
      );
    }
    const saved: CacheWarmingMode = await setCacheWarmingMode(mode);
    return NextResponse.json({ mode: saved });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
