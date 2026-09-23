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

/** 管理キーはアカウント別の認証ディレクトリに保存し、応答へは返さない。 */
export async function POST(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireAccount(id);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const raw = body?.managementKey;
    if (typeof raw !== "string" || !raw.trim() || raw.length > 4096 || /[\r\n\x00-\x1f]/.test(raw)) {
      return NextResponse.json({ error: "管理キーが不正です" }, { status: 400 });
    }
    const agentDir = await resolvePiAgentDir();
    writeOpenRouterAccountConfig(accountAuthPath(id, agentDir), { managementKey: raw.trim() });
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:openrouter`);
    return NextResponse.json({ ok: true, configured: true });
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
    writeOpenRouterAccountConfig(accountAuthPath(id, agentDir), { managementKey: null });
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:openrouter`);
    return NextResponse.json({ ok: true, configured: false });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
