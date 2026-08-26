import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { accountAuthPath } from "@/lib/accounts";

/**
 * CodexBar 利用量表示を Pi の認証ストレージへ接続する読み書き層
 * （docs/plans/multi-account.md Phase 7）。
 *
 * - 読み取りはフィールド単位のガード付き（Pi 未ログイン・破損・書込中は null）
 * - 書き戻しは他プロバイダーのエントリを保持するマージ更新
 * - アカウント別 auth.json を使う場合は呼び出し側が解決済み agentDir を渡す
 */

export type PiAuthProviderId = "openai-codex" | "anthropic";

export type PiOAuthTokens = {
  access: string;
  refresh: string | null;
  /** ms epoch。未保存の場合は null。 */
  expires: number | null;
};

/** 既定（accountId 未指定）の Pi 認証ファイル。SDK の getAgentDir と同じ解決規則。 */
export function defaultPiAuthPath(agentDirOverride?: string): string {
  const override =
    agentDirOverride?.trim() ||
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    "";
  const agentDir = override || join(homedir(), ".pi", "agent");
  return join(agentDir, "auth.json");
}

/** アカウント指定時の認証ファイルパス。accountId 未指定は既定へフォールバック。 */
export function piAuthPathFor(
  providerId: PiAuthProviderId,
  options?: { accountId?: string | null; agentDir?: string },
): string {
  const accountId = options?.accountId;
  if (accountId) {
    if (!options?.agentDir) {
      throw new Error("アカウント指定の認証ファイルには agentDir の解決が必要です");
    }
    return accountAuthPath(accountId, options.agentDir);
  }
  return defaultPiAuthPath(options?.agentDir);
}

/** Pi auth.json から OAuth トークンを読む。失敗時は null（CLI ファイルへのフォールバック用）。 */
export function readPiOAuthTokens(
  providerId: PiAuthProviderId,
  options?: { authPath?: string },
): PiOAuthTokens | null {
  const path = options?.authPath ?? piAuthPathFor(providerId);
  try {
    if (!existsSync(path)) return null;
    const root = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    if (!root || typeof root !== "object") return null;
    const entry = root[providerId];
    if (!entry || typeof entry !== "object") return null;
    const node = entry as Record<string, unknown>;
    const access = typeof node.access === "string" && node.access ? node.access : null;
    if (!access) return null;
    const refresh = typeof node.refresh === "string" && node.refresh ? node.refresh : null;
    const expires = typeof node.expires === "number" ? node.expires : null;
    return { access, refresh, expires };
  } catch {
    return null;
  }
}

/**
 * リフレッシュ結果を Pi auth.json へマージ書き込みする。
 * 他プロバイダーや未知のキーは保持する（CodexBar 単独で壊さない）。
 */
export function writeBackPiOAuthTokens(
  providerId: PiAuthProviderId,
  tokens: { access: string; refresh?: string | null; expires?: number | null },
  options?: { authPath?: string },
): void {
  const path = options?.authPath ?? piAuthPathFor(providerId);
  let root: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") root = parsed as Record<string, unknown>;
  } catch {
    /* 新規作成扱い */
  }
  const previous = (root[providerId] as Record<string, unknown> | undefined) ?? {};
  root[providerId] = {
    ...previous,
    type: "oauth",
    access: tokens.access,
    ...(tokens.refresh ? { refresh: tokens.refresh } : {}),
    expires: tokens.expires ?? Date.now() + 3_600_000,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}
