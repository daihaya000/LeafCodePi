import { ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import { jsonError, logoutProvider } from "@/lib/pi/harness";
import { resolvePiAgentDir } from "@/lib/accounts";
import { isPeerAccount } from "@/lib/peer-auth/account-runtime-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // docs/plans/multi-account.md Phase 4。null = 既定（~/.pi/agent/auth.json）。
    const accountId = new URL(req.url).searchParams.get("accountId");
    // A peer account has no local credential to log out; deleting the account is the way.
    if (accountId && isPeerAccount(accountId, await resolvePiAgentDir())) {
      return NextResponse.json({ error: "このアカウントは別のLCPから取り込んでいるためログアウトできません。共有元のLCPで認証を解除してください" }, { status: 409 });
    }
    await logoutProvider(id, accountId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: "認証操作に失敗しました" }, { status });
  }
}
