import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
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
  /** ChatGPT 側のアカウント ID。LeafCode の accountId とは別物。 */
  accountId: string | null;
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
    const accountId =
      typeof node.accountId === "string" && node.accountId.trim()
        ? node.accountId
        : typeof node.account_id === "string" && node.account_id.trim()
          ? node.account_id
          : null;
    return { access, refresh, expires, accountId };
  } catch {
    return null;
  }
}

const AUTH_LOCK_STALE_MS = 30_000;
const AUTH_LOCK_RETRY_MS = 25;
const AUTH_LOCK_MAX_WAIT_MS = 30_000;

async function acquireAuthFileLock(path: string): Promise<() => Promise<void>> {
  // FileAuthStorageBackend uses the same `${authPath}.lock` directory.
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + AUTH_LOCK_MAX_WAIT_MS;

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => {
        await rmdir(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("Pi auth.json のロックを取得できません");
      }
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > AUTH_LOCK_STALE_MS) {
          await rmdir(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // The competing lock may have been released between open/stat.
      }
      await delay(AUTH_LOCK_RETRY_MS);
    }
  }
}

async function withAuthFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireAuthFileLock(path);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * リフレッシュ結果を Pi auth.json へマージ書き込みする。
 * 他プロバイダーや未知のキーは保持し、ファイルロックで login/logout と直列化する。
 */
export async function writeBackPiOAuthTokens(
  providerId: PiAuthProviderId,
  tokens: { access: string; refresh?: string | null; expires?: number | null },
  options?: { authPath?: string },
): Promise<void> {
  const path = options?.authPath ?? piAuthPathFor(providerId);
  await withAuthFileLock(path, async () => {
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
  });
}
