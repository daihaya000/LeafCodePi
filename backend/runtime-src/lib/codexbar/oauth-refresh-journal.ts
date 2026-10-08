import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteText } from "./utils";

export type OAuthRefreshJournal<T> = {
  version: 1;
  provider: string;
  previous: T;
  refreshed: T;
};

export type OAuthRefreshRecovery<T> = {
  authPath: string;
  provider: string;
  /** Return undefined only when the auth file could not be read; null means logout/no OAuth auth. */
  readCurrent(): T | null | undefined;
  same(left: T, right: T): boolean;
  persist(refreshed: T): void | Promise<void>;
};

export function oauthRefreshJournalPath(authPath: string, provider: string): string {
  return `${authPath}.leafcode-oauth-pending-${provider}.json`;
}

export function hasOAuthRefreshJournal(authPath: string, provider: string): boolean {
  return existsSync(oauthRefreshJournalPath(authPath, provider));
}

export function readOAuthRefreshJournal<T>(
  authPath: string,
  provider: string,
): OAuthRefreshJournal<T> | null {
  try {
    const parsed = JSON.parse(readFileSync(oauthRefreshJournalPath(authPath, provider), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.provider !== provider ||
      !value.previous || typeof value.previous !== "object" || Array.isArray(value.previous) ||
      !value.refreshed || typeof value.refreshed !== "object" || Array.isArray(value.refreshed)
    ) return null;
    return value as OAuthRefreshJournal<T>;
  } catch {
    return null;
  }
}

export function writeOAuthRefreshJournal<T>(
  authPath: string,
  provider: string,
  previous: T,
  refreshed: T,
): void {
  const journal: OAuthRefreshJournal<T> = { version: 1, provider, previous, refreshed };
  // OAuth credentials are secrets; keep the sidecar at the same owner-only mode as auth.json.
  atomicWriteText(
    oauthRefreshJournalPath(authPath, provider),
    `${JSON.stringify(journal)}\n`,
    0o600,
  );
}

export function clearOAuthRefreshJournal(authPath: string, provider: string): void {
  try {
    unlinkSync(oauthRefreshJournalPath(authPath, provider));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

/**
 * Reapply a rotated token journal after a process restart. A journal is applied only while the
 * auth file still contains the exact prior credentials; logout or an external login wins.
 */
export async function recoverOAuthRefreshJournal<T>(options: OAuthRefreshRecovery<T>): Promise<T | null> {
  const { authPath, provider, readCurrent, same, persist } = options;
  const journal = readOAuthRefreshJournal<T>(authPath, provider);
  if (!journal) return null;

  const current = readCurrent();
  if (current === undefined) return null; // Keep the journal until auth can be inspected safely.
  if (current === null) {
    clearOAuthRefreshJournal(authPath, provider);
    return null;
  }
  if (same(current, journal.refreshed)) {
    clearOAuthRefreshJournal(authPath, provider);
    return current;
  }
  if (current && !same(current, journal.previous)) {
    clearOAuthRefreshJournal(authPath, provider);
    return current;
  }
  try {
    await persist(journal.refreshed);
  } catch {
    // Keep both the journal and the rotated in-memory credentials for a later retry.
  }
  const written = readCurrent();
  if (written === undefined) return journal.refreshed;
  if (written === null) {
    clearOAuthRefreshJournal(authPath, provider);
    return null;
  }
  if (same(written, journal.refreshed)) {
    clearOAuthRefreshJournal(authPath, provider);
    return written;
  }
  if (written && !same(written, journal.previous)) {
    // An external writer changed auth while persistence was retried; don't replay over it.
    clearOAuthRefreshJournal(authPath, provider);
    return written;
  }
  return journal.refreshed;
}
