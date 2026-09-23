import { NextRequest, NextResponse } from "next/server";
import { accountAuthPath, getAccount, resolvePiAgentDir } from "@/lib/accounts";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { writeOpenRouterAccountConfig } from "@/lib/codexbar/providers/openrouter";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function requireAccount(id: string): void {
  const account = getAccount(id);
  if (!account) throw Object.assign(new Error("アカウントが見つかりません"), { status: 404 });
  if (!account.providers.includes("openrouter")) {
    throw Object.assign(new Error("このアカウントは OpenRouter に対応していません"), { status: 400 });
  }
}

export async function POST(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireAccount(id);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const baselineUsd = body?.baselineUsd;
    if (typeof baselineUsd !== "number" || !Number.isFinite(baselineUsd) || baselineUsd <= 0 || baselineUsd > 1_000_000) {
      return NextResponse.json({ error: "baselineUsd は 0 より大きく 1000000 以下で指定してください" }, { status: 400 });
    }
    const agentDir = await resolvePiAgentDir();
    writeOpenRouterAccountConfig(accountAuthPath(id, agentDir), { creditBaselineUsd: baselineUsd });
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:openrouter`);
    return NextResponse.json({ ok: true, baselineUsd });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireAccount(id);
    const agentDir = await resolvePiAgentDir();
    writeOpenRouterAccountConfig(accountAuthPath(id, agentDir), { creditBaselineUsd: null });
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:openrouter`);
    return NextResponse.json({ ok: true, baselineUsd: null });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
