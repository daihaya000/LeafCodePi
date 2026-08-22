import { NextResponse } from "next/server";
import { listModels, jsonError } from "@/lib/pi/harness";
import { fetchNativeUsage } from "@/lib/codexbar/orchestrator";
import type { CodexBarProvider } from "@/lib/codexbar";
import { attachCodexBarUsage } from "./map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Best-effort usage lookup; never block model listing on cold CodexBar fetches. */
const USAGE_LOOKUP_TIMEOUT_MS = 2_500;

export async function GET() {
  try {
    const models = await listModels();
    let providers: CodexBarProvider[] = [];
    try {
      providers = (
        await fetchNativeUsage({ signal: AbortSignal.timeout(USAGE_LOOKUP_TIMEOUT_MS) })
      ).providers;
    } catch {
      /* usage unavailable or timed out → models without usage info */
    }
    return NextResponse.json({ models: attachCodexBarUsage(models, providers) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
