import { NextResponse } from "next/server";
import { listModels, jsonError } from "@/lib/pi/harness";
import { fetchNativeUsage } from "@/lib/codexbar/orchestrator";
import type { CodexBarProvider } from "@/lib/codexbar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Map pi provider id → CodexBar provider id (subset that has usage data). */
export const CODEXBAR_PROVIDER_MAP: Record<string, string> = {
  anthropic: "claude",
  "openai-codex": "codex",
  cursor: "cursor",
  "ollama-cloud": "ollama",
  commandcode: "commandcode",
  "opencode-go": "opencode-go",
  synthetic: "synthetic",
  "qwen-cloud": "qwen-cloud",
  openrouter: "openrouter",
};

export function attachCodexBarUsage<T extends { providerID: string }>(
  options: T[],
  providers: CodexBarProvider[],
): T[] {
  if (providers.length === 0) return options;
  const byId = new Map(providers.map((p) => [p.id, p]));
  return options.map((option) => {
    const p = byId.get(CODEXBAR_PROVIDER_MAP[option.providerID]);
    if (!p) return option;
    return {
      ...option,
      codexbarUsedPercent: p.usedPercent,
      codexbarMaxed: p.maxed,
    };
  });
}

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
