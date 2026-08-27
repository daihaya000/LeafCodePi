import { NextRequest, NextResponse } from "next/server";
import { getAccount } from "@/lib/accounts";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { deleteOllamaCookieFile, saveOllamaCookieFile } from "@/lib/codexbar/providers/ollama-cloud";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function requireOllamaAccount(id: string): void {
  const account = getAccount(id);
  if (!account) throw Object.assign(new Error("アカウントが見つかりません"), { status: 404 });
  if (!account.providers.includes("ollama-cloud")) {
    throw Object.assign(new Error("このアカウントは Ollama Cloud に対応していません"), { status: 400 });
  }
}

/** Ollama の cookie 本文は返さず、アカウント別ファイルへ保存する。 */
export async function POST(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireOllamaAccount(id);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.cookies !== "string") {
      return NextResponse.json({ error: "cookies は文字列で指定してください" }, { status: 400 });
    }
    saveOllamaCookieFile(id, body.cookies);
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:ollama-cloud`);
    return NextResponse.json({ ok: true, configured: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** アカウント別 Ollama cookie を削除する。 */
export async function DELETE(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    requireOllamaAccount(id);
    deleteOllamaCookieFile(id);
    invalidateCachedUsage();
    clearProviderCache(`account:${id}:ollama-cloud`);
    return NextResponse.json({ ok: true, configured: false });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
