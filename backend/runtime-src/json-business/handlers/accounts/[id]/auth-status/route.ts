import { ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse } from "../../../../../configuration/http";
import {
  accountAuthPath,
  accountCredentialKinds,
  accountStoredProviders,
  getAccount,
  resolvePiAgentDir,
} from "@/lib/accounts";
import { extractOpenCodeCookieHeader } from "@/lib/codexbar/browser-cookies";
import { isPeerAccount } from "@/lib/peer-auth/account-runtime-options";
import { hasAnthropicConsoleCookie, readAnthropicCreditBaseline } from "@/lib/codexbar/providers/anthropic";
import { isOllamaCookieConfigured } from "@/lib/codexbar/providers/ollama-cloud";
import { readOpenRouterCreditBaseline, readOpenRouterManagementKey } from "@/lib/codexbar/providers/openrouter";
import { hasOpenDesignCookie } from "@/lib/codexbar/providers/opendesign";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * アカウントの auth.json に保存済みのプロバイダー一覧（認証バッジ表示用）。
 * ランタイムを起動しない軽量なファイル読み。未ログイン・破損時は空配列。
 */
export async function GET(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  try {
    if (!getAccount(id)) {
      return NextResponse.json(
        { error: "アカウントが見つかりません" },
        { status: 404 },
      );
    }
    const agentDir = await resolvePiAgentDir();
    return NextResponse.json({
      providers: accountStoredProviders(id, agentDir),
      credentialKinds: accountCredentialKinds(id, agentDir),
      // 別LCPから取り込んだアカウントは、このLCP側でログイン/ログアウトできない。
      peer: isPeerAccount(id, agentDir),
      ollamaCookieConfigured: isOllamaCookieConfigured(id),
      opendesignCookieConfigured: hasOpenDesignCookie(accountAuthPath(id, agentDir)),
      opencodeGoCookieConfigured:
        extractOpenCodeCookieHeader({
          authPath: accountAuthPath(id, agentDir),
        }) !== null,
      anthropicCookieConfigured: hasAnthropicConsoleCookie(
        accountAuthPath(id, agentDir),
      ),
      anthropicCreditBaseline: readAnthropicCreditBaseline(
        accountAuthPath(id, agentDir),
      ),
      openrouterManagementKeyConfigured: readOpenRouterManagementKey(
        accountAuthPath(id, agentDir),
      ) !== null,
      openrouterCreditBaseline: readOpenRouterCreditBaseline(
        accountAuthPath(id, agentDir),
      ),
    });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
