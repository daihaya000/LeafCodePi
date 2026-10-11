import { ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { accountAuthPath, getAccount, resolvePiAgentDir } from "@/lib/accounts";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { deleteOpenDesignCookie, readOpenDesignWorkspaceId, saveOpenDesignCookie, validateOpenDesignCookie } from "@/lib/codexbar/providers/opendesign";
import { isPeerAccount } from "@/lib/peer-auth/account-runtime-options";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function requireAccount(id: string): Promise<string> {
  const account = getAccount(id);
  if (!account) throw Object.assign(new Error("アカウントが見つかりません"), { status: 404 });
  if (!account.providers.includes("opendesign")) throw Object.assign(new Error("このアカウントは OpenDesign に対応していません"), { status: 400 });
  const agentDir = await resolvePiAgentDir();
  if (isPeerAccount(id, agentDir)) throw Object.assign(new Error("共有元が管理するアカウントは変更できません"), { status: 403 });
  return accountAuthPath(id, agentDir);
}
function invalidate(id: string) {
  invalidateCachedUsage();
  clearProviderCache(`account:${id}:opendesign`);
}
/** Verify the session and selected workspace before saving. Never return the cookie. */
export async function POST(req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    const authPath = await requireAccount(id);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.cookies !== "string") return NextResponse.json({ error: "cookies は文字列で指定してください" }, { status: 400 });
    if (body.workspaceId !== undefined && (typeof body.workspaceId !== "string" || body.workspaceId.length > 128)) {
      return NextResponse.json({ error: "workspaceId は128文字以内の文字列で指定してください" }, { status: 400 });
    }
    const selectedWorkspaceId = (body.workspaceId as string | undefined) ?? readOpenDesignWorkspaceId(authPath) ?? undefined;
    const workspaceId = await validateOpenDesignCookie(body.cookies, req.signal, selectedWorkspaceId);
    saveOpenDesignCookie(authPath, body.cookies, workspaceId);
    invalidate(id);
    return NextResponse.json({ ok: true, configured: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
export async function DELETE(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    deleteOpenDesignCookie(await requireAccount(id));
    invalidate(id);
    return NextResponse.json({ ok: true, configured: false });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
