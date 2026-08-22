import { NextResponse } from "next/server";
import { listModels, jsonError } from "@/lib/pi/harness";
import { getCachedUsage } from "@/lib/codexbar/cache";
import { attachCodexBarUsage } from "./map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the aggregate cache only — never fetch here. A short-timeout
 * fetchNativeUsage aborts slow providers mid-flight and poisons their
 * per-provider caches with errors. The CodexBar widget (~5min poll) keeps
 * the cache warm; allow up to 30 min stale for dropdown coloring.
 */
const USAGE_MAX_AGE_MS = 30 * 60 * 1000;

export async function GET() {
  try {
    const models = await listModels();
    const providers = getCachedUsage(Date.now(), USAGE_MAX_AGE_MS)?.providers ?? [];
    return NextResponse.json({ models: attachCodexBarUsage(models, providers) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
