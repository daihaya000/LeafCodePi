/**
 * Claude Code usage via Anthropic OAuth usage API + token refresh.
 * Auth: ~/.claude/.credentials.json (CLAUDE_CONFIG_DIR).
 *
 * API キー（従量課金）アカウントは枠/利用率を返さないため、Console の cookie
 * （platform.claude.com）でプリペイドのクレジット残高を表示する。
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ProviderError,
  type IUsageProvider,
  type RateWindow,
  type UsageScope,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import {
  asRecord,
  atomicWriteText,
  clamp,
  cleanApiKey,
  fetchText,
  flexibleNumber,
  withRefreshFileLock,
} from "@/lib/codexbar/utils";
import {
  createCookieHeaderForUrl,
  extractAnthropicConsoleSession,
  readAnthropicConsoleOrgId,
  type BrowserCookieSession,
} from "@/lib/codexbar/browser-cookies";
import {
  claudeWebCookieHeader,
  listClaudeResetGrants,
} from "@/lib/codexbar/providers/anthropic-reset";
import {
  piAuthPathFor,
  readPiApiKey,
  readPiOAuthTokens,
  writeBackPiOAuthTokens,
} from "@/lib/codexbar/pi-auth";
import {
  clearOAuthRefreshJournal,
  hasOAuthRefreshJournal,
  readOAuthRefreshJournal,
  recoverOAuthRefreshJournal,
  writeOAuthRefreshJournal,
} from "@/lib/codexbar/oauth-refresh-journal";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CONSOLE_ORIGIN = "https://platform.claude.com";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";

type ClaudeCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  subscriptionType: string | null;
};

type PendingClaudeCredentials = {
  previous: ClaudeCredentials;
  refreshed: ClaudeCredentials;
};

type ClaudeJournalCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  subscriptionType: string | null;
};

const ANTHROPIC_CLI_JOURNAL = "anthropic-cli";
const ANTHROPIC_PI_JOURNAL = "anthropic-pi";

function toJournalCredentials(credentials: ClaudeCredentials): ClaudeJournalCredentials {
  return {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt?.getTime() ?? null,
    subscriptionType: credentials.subscriptionType,
  };
}

function fromJournalCredentials(credentials: ClaudeJournalCredentials): ClaudeCredentials {
  return {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt === null ? null : new Date(credentials.expiresAt),
    subscriptionType: credentials.subscriptionType,
  };
}

function sameJournalCredentials(left: ClaudeJournalCredentials, right: ClaudeJournalCredentials): boolean {
  return left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt &&
    left.subscriptionType === right.subscriptionType;
}

function clearAnthropicJournal(path: string, provider: string): void {
  try { clearOAuthRefreshJournal(path, provider); } catch { /* a later recovery can clear it */ }
}

type DiskCredentialsRead = {
  readable: boolean;
  credentials: ClaudeCredentials | null;
};

// Keep rotated credentials in-process if persistence fails, but only while disk still has the exact prior auth.
const pendingRefreshCredentials = new Map<string, PendingClaudeCredentials>();
const pendingPersistenceRetries = new Map<string, Promise<void>>();

function credentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const root = configDir?.trim()
    ? configDir.trim()
    : join(homedir(), ".claude");
  return join(root, ".credentials.json");
}

function prettyPlan(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  switch (raw) {
    case "pro":
      return "Pro";
    case "max":
      return "Max";
    case "team":
      return "Team";
    case "enterprise":
      return "Enterprise";
    case "free":
      return "Free";
    default:
      return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
}

function sameCredentials(left: ClaudeCredentials, right: ClaudeCredentials): boolean {
  return left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt?.getTime() === right.expiresAt?.getTime() &&
    left.subscriptionType === right.subscriptionType;
}

function readCredentialsFromDisk(path: string): DiskCredentialsRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { readable: false, credentials: null };
  }
  try {
    const root = asRecord(JSON.parse(raw));
    const oauth = asRecord(root?.claudeAiOauth);
    if (!oauth) return { readable: true, credentials: null };
    const accessToken =
      typeof oauth.accessToken === "string" ? oauth.accessToken : null;
    if (!accessToken) return { readable: true, credentials: null };
    const refreshToken =
      typeof oauth.refreshToken === "string" ? oauth.refreshToken : null;
    let expiresAt: Date | null = null;
    if (typeof oauth.expiresAt === "number") {
      expiresAt = new Date(oauth.expiresAt);
    }
    const subscriptionType =
      typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null;
    return { readable: true, credentials: { accessToken, refreshToken, expiresAt, subscriptionType } };
  } catch {
    return { readable: false, credentials: null };
  }
}

function loadCredentials(path = credentialsPath()): ClaudeCredentials | null {
  const { readable, credentials: loaded } = readCredentialsFromDisk(path);
  let pending = pendingRefreshCredentials.get(path);
  if (!pending) {
    const journal = readOAuthRefreshJournal<ClaudeJournalCredentials>(path, ANTHROPIC_CLI_JOURNAL);
    if (journal) {
      pending = {
        previous: fromJournalCredentials(journal.previous),
        refreshed: fromJournalCredentials(journal.refreshed),
      };
      pendingRefreshCredentials.set(path, pending);
    }
  }
  if (!readable) {
    if (pending && existsSync(path)) return pending.refreshed;
    pendingRefreshCredentials.delete(path);
    if (!existsSync(path)) clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
    return null;
  }
  if (!loaded) {
    pendingRefreshCredentials.delete(path);
    clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
    return null;
  }
  if (!pending) return loaded;
  if (sameCredentials(loaded, pending.refreshed)) {
    pendingRefreshCredentials.delete(path);
    clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
    return loaded;
  }
  if (sameCredentials(loaded, pending.previous)) return pending.refreshed;
  pendingRefreshCredentials.delete(path);
  clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
  return loaded;
}

function persistTokens(
  accessToken: string,
  refreshToken: string,
  expiresAt: Date,
  path = credentialsPath(),
): void {
  try {
    const node = asRecord(JSON.parse(readFileSync(path, "utf8"))) ?? {};
    const oauth = asRecord(node.claudeAiOauth) ?? {};
    oauth.accessToken = accessToken;
    oauth.refreshToken = refreshToken;
    oauth.expiresAt = expiresAt.getTime();
    node.claudeAiOauth = oauth;
    atomicWriteText(path, JSON.stringify(node));
  } catch {
    /* best effort */
  }
}

function retryPendingCredentialPersistence(path: string): void {
  loadCredentials(path); // Rehydrate process-local state from a durable journal after restart.
  const pending = pendingRefreshCredentials.get(path);
  if (!pending || pendingPersistenceRetries.has(path)) return;

  const retry = withRefreshFileLock(path, async () => {
    if (pendingRefreshCredentials.get(path) !== pending) return;
    const disk = readCredentialsFromDisk(path);
    if (!disk.readable) {
      if (!existsSync(path)) pendingRefreshCredentials.delete(path);
      return;
    }
    if (!disk.credentials || !sameCredentials(disk.credentials, pending.previous)) {
      pendingRefreshCredentials.delete(path);
      clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
      return;
    }
    const { refreshed } = pending;
    if (!refreshed.refreshToken || !refreshed.expiresAt) return;

    persistTokens(refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt, path);
    const written = readCredentialsFromDisk(path);
    if (!written.readable) {
      if (!existsSync(path)) pendingRefreshCredentials.delete(path);
      return;
    }
    if (written.credentials && sameCredentials(written.credentials, refreshed)) {
      pendingRefreshCredentials.delete(path);
      clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
    } else if (!written.credentials || !sameCredentials(written.credentials, pending.previous)) {
      pendingRefreshCredentials.delete(path);
      clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
    }
  }).catch(() => {
    // A failed best-effort retry leaves the in-memory credentials available for this process.
  });
  pendingPersistenceRetries.set(path, retry);
  void retry.finally(() => {
    if (pendingPersistenceRetries.get(path) === retry) pendingPersistenceRetries.delete(path);
  });
}

/** One refresh per credentials file at a time: the IdP rotates refresh tokens, so a second concurrent use of the same one would invalidate the first result. */
const refreshInFlight = new Map<string, Promise<ClaudeCredentials | null>>();

/** Test-only: run a callback under the same cross-process refresh lock. */
export function __withRefreshLockForTests<T>(path: string, run: () => Promise<T>): Promise<T> {
  return withRefreshFileLock(path, run);
}

function tryRefreshTokens(
  creds: ClaudeCredentials,
  signal?: AbortSignal,
  credentialsPathOverride?: string,
): Promise<ClaudeCredentials | null> {
  const key = credentialsPathOverride ?? credentialsPath();
  const pending = refreshInFlight.get(key);
  if (pending) return pending;
  const run = withRefreshFileLock(key, () => {
    // Another process may have rotated tokens while this caller waited for the lock.
    const latest = loadCredentials(key);
    if (!latest) return Promise.resolve(null);
    const accessChanged = latest.accessToken !== creds.accessToken;
    if (accessChanged && (!latest.expiresAt || latest.expiresAt.getTime() > Date.now() + 60_000)) {
      return Promise.resolve(latest);
    }
    // Unchanged credentials may still need refresh after a 401, even before expiry.
    return refreshTokensOnce(latest, signal, key);
  }).finally(() => {
    if (refreshInFlight.get(key) === run) refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, run);
  return run;
}

async function refreshTokensOnce(
  creds: ClaudeCredentials,
  signal?: AbortSignal,
  credentialsPathOverride?: string,
): Promise<ClaudeCredentials | null> {
  if (!creds.refreshToken) return null;
  try {
    const { ok, body } = await fetchText(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: CLIENT_ID,
      }),
      signal,
    });
    if (!ok) return null;
    const root = asRecord(JSON.parse(body));
    const accessToken =
      typeof root?.access_token === "string" ? root.access_token : null;
    if (!accessToken) return null;
    const refreshToken =
      typeof root?.refresh_token === "string"
        ? root.refresh_token
        : creds.refreshToken;
    const expiresIn =
      typeof root?.expires_in === "number" ? root.expires_in : 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const path = credentialsPathOverride ?? credentialsPath();
    const refreshed = { accessToken, refreshToken, expiresAt, subscriptionType: creds.subscriptionType };
    try {
      writeOAuthRefreshJournal(
        path,
        ANTHROPIC_CLI_JOURNAL,
        toJournalCredentials(creds),
        toJournalCredentials(refreshed),
      );
    } catch {
      // Main auth persistence is still attempted; only restart recovery is unavailable if both writes fail.
    }
    persistTokens(accessToken, refreshToken, expiresAt, path);
    const disk = readCredentialsFromDisk(path);
    if (disk.credentials && sameCredentials(disk.credentials, refreshed)) {
      pendingRefreshCredentials.delete(path);
      clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
      return disk.credentials;
    }
    if (
      (disk.credentials && sameCredentials(disk.credentials, creds)) ||
      (!disk.readable && existsSync(path))
    ) {
      pendingRefreshCredentials.set(path, { previous: creds, refreshed });
      return refreshed;
    }
    pendingRefreshCredentials.delete(path);
    clearAnthropicJournal(path, ANTHROPIC_CLI_JOURNAL);
    return disk.credentials ?? refreshed;
  } catch {
    return null;
  }
}

function readAccountEmail(): string | null {
  const candidates: string[] = [];
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir?.trim()) candidates.push(join(configDir.trim(), ".claude.json"));
  candidates.push(join(homedir(), ".claude.json"));
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const root = asRecord(JSON.parse(readFileSync(path, "utf8")));
      const account = asRecord(root?.oauthAccount);
      if (typeof account?.emailAddress === "string" && account.emailAddress) {
        return account.emailAddress;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function addWindow(
  windows: RateWindow[],
  root: Record<string, unknown>,
  key: string,
  id: string,
  title: string,
  durationMs: number,
): void {
  const win = asRecord(root[key]);
  if (!win) return;
  const utilization = flexibleNumber(win.utilization);
  if (utilization === null) return;
  let resetsAt: Date | null = null;
  if (typeof win.resets_at === "string") {
    const t = Date.parse(win.resets_at);
    if (!Number.isNaN(t)) resetsAt = new Date(t);
  }
  windows.push({
    id,
    title,
    usedPercent: clamp(utilization, 0, 100),
    resetsAt,
    windowDurationMs: durationMs,
    countsTowardLimit: true,
  });
}

function slugifyLimitId(value: string): string {
  let slug = "";
  let pending = false;
  for (const ch of value.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      if (pending && slug.length > 0) slug += "-";
      slug += ch;
      pending = false;
    } else {
      pending = true;
    }
  }
  return slug;
}

function readScopedModelProperty(
  entry: Record<string, unknown>,
  propertyName: string,
): string | null {
  const scope = asRecord(entry.scope);
  const model = asRecord(scope?.model);
  const text = model?.[propertyName];
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

export function parseClaudeUsageJson(
  json: string,
  subscriptionType: string | null = null,
): UsageSnapshot {
  const root = asRecord(JSON.parse(json));
  if (!root) throw new ProviderError("Claude の応答形式が不正です。");

  const windows: RateWindow[] = [];
  addWindow(windows, root, "five_hour", "claude-5h", "5時間", 5 * 3600_000);
  addWindow(windows, root, "seven_day", "claude-weekly", "週間", 7 * 86400_000);
  addWindow(
    windows,
    root,
    "seven_day_sonnet",
    "claude-weekly-sonnet",
    "週間 (Sonnet)",
    7 * 86400_000,
  );
  addWindow(
    windows,
    root,
    "seven_day_opus",
    "claude-weekly-opus",
    "週間 (Opus)",
    7 * 86400_000,
  );

  const hasFlatWindows = windows.length > 0;
  const windowIds = new Set(windows.map((w) => w.id));
  if (Array.isArray(root.limits)) {
    let index = 0;
    for (const raw of root.limits) {
      const entry = asRecord(raw);
      if (!entry) continue;
      const percent = flexibleNumber(entry.percent);
      if (percent === null || !Number.isFinite(percent)) continue;
      let resetsAt: Date | null = null;
      if (typeof entry.resets_at === "string") {
        const t = Date.parse(entry.resets_at);
        if (!Number.isNaN(t)) resetsAt = new Date(t);
      }
      const group = typeof entry.group === "string" ? entry.group : null;
      const kind = typeof entry.kind === "string" ? entry.kind : null;
      if (
        kind?.toLowerCase() === "weekly_scoped" &&
        group?.toLowerCase() === "weekly"
      ) {
        const modelId = readScopedModelProperty(entry, "id");
        const modelName = readScopedModelProperty(entry, "display_name");
        const modelLabel = modelName ?? modelId;
        if (!modelLabel?.trim()) continue;
        const slug = slugifyLimitId(modelId ?? modelLabel);
        if (!slug) continue;
        const id = `claude-weekly-scoped-${slug}`;
        if (windowIds.has(id)) continue;
        windowIds.add(id);
        windows.push({
          id,
          title: `週間 (${modelLabel})`,
          usedPercent: clamp(percent, 0, 100),
          resetsAt,
          windowDurationMs: 7 * 86400_000,
          countsTowardLimit: true,
        });
        continue;
      }
      if (hasFlatWindows) continue;
      const title =
        group === "session"
          ? "5時間"
          : group === "weekly"
            ? "週間"
            : (group ?? `制限 ${index + 1}`);
      windows.push({
        id: `claude-limit-${index}`,
        title,
        usedPercent: clamp(percent, 0, 100),
        resetsAt,
        windowDurationMs: null,
        countsTowardLimit: true,
      });
      index++;
    }
  }

  let creditsEnabled = false;
  let creditsUsed: number | null = null;
  let creditsLimit: number | null = null;
  const extra = asRecord(root.extra_usage);
  if (extra && extra.is_enabled === true) {
    creditsEnabled = true;
    creditsUsed = (flexibleNumber(extra.used_credits) ?? 0) / 100;
    creditsLimit = (flexibleNumber(extra.monthly_limit) ?? 0) / 100;
  }

  return {
    providerId: "anthropic",
    providerName: "Claude",
    plan: prettyPlan(subscriptionType),
    accountEmail: null,
    windows,
    creditsEnabled,
    creditsTitle: creditsEnabled ? "利用クレジット" : null,
    creditsUsed,
    creditsLimit,
    creditsBalance: null,
    creditsLabel: null,
    sourceLabel: "OAuth API",
    updatedAt: new Date(),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

/**
 * Console の prepaid credits（`{ amount }`、セント単位）を残高スナップショットへ。
 * API キー（従量課金）アカウントの表示用。
 */
export function parseAnthropicPrepaidCreditsJson(json: string): UsageSnapshot {
  const root = asRecord(JSON.parse(json));
  const amountCents = flexibleNumber(root?.amount);
  if (!root || amountCents === null) {
    throw new ProviderError("Anthropic のクレジット応答形式が不正です。");
  }
  return {
    providerId: "anthropic",
    providerName: "Claude",
    plan: "API",
    accountEmail: null,
    windows: [],
    creditsEnabled: true,
    creditsTitle: "API クレジット",
    creditsUsed: null,
    creditsLimit: null,
    creditsBalance: amountCents / 100,
    creditsLabel: null,
    // 残高から導出した％は表示専用（集計やルーティングには使わない）。
    usageDisplayOnly: true,
    sourceLabel: "platform.claude.com",
    updatedAt: new Date(),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

/**
 * Pi の auth.json（既定ストア）から認証を組む。Pi は subscriptionType を保存しないため
 * プラン表示は縮退（null）。email も ~/.claude.json 由来のため Pi 経由では出さない。
 */
function loadCredentialsFromPi(path?: string): ClaudeCredentials | null {
  const tokens = readPiOAuthTokens(
    "anthropic",
    path ? { authPath: path } : undefined,
  );
  if (!tokens) return null;
  return {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: tokens.expires ? new Date(tokens.expires) : null,
    subscriptionType: null,
  };
}

function readAnthropicPiJournalCredentials(path: string): ClaudeJournalCredentials | null | undefined {
  try {
    readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : undefined;
  }
  try {
    const current = loadCredentialsFromPi(path);
    return current ? toJournalCredentials(current) : null;
  } catch {
    return undefined;
  }
}

async function recoverAnthropicPiRefresh(path: string): Promise<ClaudeCredentials | null> {
  if (!hasOAuthRefreshJournal(path, ANTHROPIC_PI_JOURNAL)) return null;
  try {
    const recovered = await withRefreshFileLock(path, () => recoverOAuthRefreshJournal({
      authPath: path,
      provider: ANTHROPIC_PI_JOURNAL,
      readCurrent: () => readAnthropicPiJournalCredentials(path),
      same: sameJournalCredentials,
      persist: async (credentials) => writeBackPiOAuthTokens(
        "anthropic",
        {
          access: credentials.accessToken,
          refresh: credentials.refreshToken,
          expires: credentials.expiresAt,
        },
        { authPath: path },
      ),
    }));
    return recovered ? fromJournalCredentials(recovered) : null;
  } catch {
    return null;
  }
}

/** Pi auth.json refresh. Serialize processes and reuse credentials refreshed while waiting for the lock. */
function tryRefreshTokensInPi(
  creds: ClaudeCredentials,
  signal?: AbortSignal,
  authPathOverride?: string,
): Promise<ClaudeCredentials | null> {
  if (!creds.refreshToken) return Promise.resolve(null);
  const path = authPathOverride ?? piAuthPathFor("anthropic");
  const pending = refreshInFlight.get(path);
  if (pending) return pending;
  const run = withRefreshFileLock(path, async () => {
    const recoveredJournal = await recoverOAuthRefreshJournal({
      authPath: path,
      provider: ANTHROPIC_PI_JOURNAL,
      readCurrent: () => readAnthropicPiJournalCredentials(path),
      same: sameJournalCredentials,
      persist: async (credentials) => writeBackPiOAuthTokens(
        "anthropic",
        {
          access: credentials.accessToken,
          refresh: credentials.refreshToken,
          expires: credentials.expiresAt,
        },
        { authPath: path },
      ),
    });
    const latest = (recoveredJournal ? fromJournalCredentials(recoveredJournal) : null) ?? loadCredentialsFromPi(path);
    if (!latest) return null;
    const accessChanged = latest.accessToken !== creds.accessToken;
    if (accessChanged && (!latest.expiresAt || latest.expiresAt.getTime() > Date.now() + 60_000)) {
      return Promise.resolve(latest);
    }
    return refreshTokensInPiOnce(latest, signal, path);
  }).finally(() => {
    if (refreshInFlight.get(path) === run) refreshInFlight.delete(path);
  });
  refreshInFlight.set(path, run);
  return run;
}

async function refreshTokensInPiOnce(
  creds: ClaudeCredentials,
  signal: AbortSignal | undefined,
  authPath: string,
): Promise<ClaudeCredentials | null> {
  if (!creds.refreshToken) return null;
  try {
    const { ok, body } = await fetchText(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: CLIENT_ID,
      }),
      signal,
    });
    if (!ok) return null;
    const root = asRecord(JSON.parse(body));
    const accessToken = typeof root?.access_token === "string" ? root.access_token : null;
    if (!accessToken) return null;
    const refreshToken =
      typeof root?.refresh_token === "string" ? root.refresh_token : creds.refreshToken;
    const expiresIn = typeof root?.expires_in === "number" ? root.expires_in : 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const refreshed = { accessToken, refreshToken, expiresAt, subscriptionType: null };
    try {
      writeOAuthRefreshJournal(
        authPath,
        ANTHROPIC_PI_JOURNAL,
        toJournalCredentials(creds),
        toJournalCredentials(refreshed),
      );
    } catch {
      // Continue with the new access token; durable recovery is unavailable only if both writes fail.
    }
    try {
      await writeBackPiOAuthTokens(
        "anthropic",
        {
          access: accessToken,
          refresh: refreshToken,
          expires: expiresAt.getTime(),
        },
        { authPath },
      );
      clearAnthropicJournal(authPath, ANTHROPIC_PI_JOURNAL);
    } catch {
      // The journal retains the rotated pair for the next process/poll.
    }
    return refreshed;
  } catch {
    return null;
  }
}

async function fetchFromApi(
  creds: ClaudeCredentials,
  signal?: AbortSignal,
  options?: { piSource?: boolean },
): Promise<UsageSnapshot> {
  const { status, body, ok } = await fetchText(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      Accept: "application/json",
      "anthropic-beta": BETA_HEADER,
      "User-Agent": USER_AGENT,
    },
    signal,
  });
  if (status === 401) throw new ProviderError("__unauthorized__");
  if (status === 429) {
    throw new ProviderError(
      "Claude の usage API がレート制限中です。数分後に再試行してください。",
      { code: "rate_limit" },
    );
  }
  if (!ok) throw new ProviderError(`Claude API エラー ${status}。`);
  const snap = parseClaudeUsageJson(body, creds.subscriptionType);
  // email は CLI の ~/.claude.json 由来のため Pi 経由では出さない
  return { ...snap, accountEmail: options?.piSource ? null : readAccountEmail() };
}

/**
 * API キー（従量課金）の残高は公開 API に無く、Console のセッション cookie
 * （sessionKey + lastActiveOrg）で platform.claude.com の内部 API を読む。
 */
export function resolveAnthropicApiKey(scope: UsageScope): string | null {
  const stored = cleanApiKey(
    readPiApiKey(
      "anthropic",
      scope.authPath ? { authPath: scope.authPath } : undefined,
    ),
  );
  if (stored) return stored;
  // アカウントスコープでは env へフォールバックしない（残高の取り違えを防ぐ）。
  if (scope.kind === "account") return null;
  return cleanApiKey(process.env.ANTHROPIC_API_KEY);
}

/** アカウント別 Console cookie の有無（軽量なファイル読み。Chromium は見ない）。 */
export function hasAnthropicConsoleCookie(authPath: string): boolean {
  return extractAnthropicConsoleSession({ authPath }) !== null;
}

function accountAnthropicConfigPath(authPath: string): string {
  return join(dirname(authPath), "anthropic.json");
}

/**
 * API キー（従量課金）口座の基準残高（購入額 USD）。
 * 残高だけでは使用率が出せないため、UI から手入力して used/limit を導出する。
 * 未設定は null。
 */
export function readAnthropicCreditBaseline(authPath: string): number | null {
  try {
    const path = accountAnthropicConfigPath(authPath);
    if (!existsSync(path)) return null;
    const root = JSON.parse(readFileSync(path, "utf8")) as {
      creditBaselineUsd?: unknown;
    };
    const value = flexibleNumber(root.creditBaselineUsd);
    return value !== null && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** 基準残高を保存する（null / 0 以下は削除）。 */
export function writeAnthropicCreditBaseline(
  authPath: string,
  baselineUsd: number | null,
): void {
  const path = accountAnthropicConfigPath(authPath);
  if (baselineUsd === null || !(baselineUsd > 0)) {
    try {
      unlinkSync(path);
    } catch {
      /* already absent */
    }
    return;
  }
  atomicWriteText(
    path,
    `${JSON.stringify({ creditBaselineUsd: baselineUsd }, null, 2)}\n`,
  );
}

/**
 * 基準残高があれば残高から used/limit を導出する（表示側が％を計算する）。
 * 残高が基準を上回る（買い増し後）場合は使用量 0 扱い。
 */
export function applyCreditBaseline(
  snapshot: UsageSnapshot,
  baselineUsd: number | null,
): UsageSnapshot {
  if (
    baselineUsd === null ||
    !(baselineUsd > 0) ||
    snapshot.creditsBalance === null
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    creditsUsed: clamp(baselineUsd - snapshot.creditsBalance, 0, baselineUsd),
    creditsLimit: baselineUsd,
  };
}

function missingCredentialsMessage(
  strictAccount: boolean,
  hasApiKey: boolean,
): string {
  if (hasApiKey) {
    return strictAccount
      ? "このアカウントの API キー残高には Anthropic Console の cookie が必要です。設定画面で platform.claude.com の cookie（Netscape形式）を登録してください。"
      : "Anthropic Console の cookie が見つかりません。platform.claude.com にログインしたブラウザの cookie を登録してください。";
  }
  return strictAccount
    ? "このアカウントの Claude 認証情報がありません。ログインするか API キーを登録してください。"
    : "Claude の認証情報が見つかりません。WebUI の「ログイン」・API キー、または `claude` CLI でサインインしてください。";
}

function consoleCreditsUrl(orgId: string): string {
  return `${CONSOLE_ORIGIN}/api/organizations/${encodeURIComponent(orgId)}/prepaid/credits`;
}

async function fetchCreditsFromConsole(
  session: BrowserCookieSession,
  signal?: AbortSignal,
  baselineUsd: number | null = null,
): Promise<UsageSnapshot> {
  const orgId = readAnthropicConsoleOrgId(session);
  if (!orgId) {
    throw new ProviderError(
      "Anthropic Console の cookie に組織ID（lastActiveOrg）がありません。platform.claude.com の cookie をエクスポートし直してください。",
    );
  }
  const url = consoleCreditsUrl(orgId);
  const cookieHeader = createCookieHeaderForUrl(session, url);
  if (!cookieHeader) {
    throw new ProviderError(
      "Anthropic Console（platform.claude.com）へ送れる cookie がありません。Console にログインしたブラウザの cookie を登録してください。",
    );
  }

  const { status, body, ok } = await fetchText(url, {
    headers: { Accept: "application/json", Cookie: cookieHeader },
    signal,
  });
  if (status === 401 || status === 403) {
    throw new ProviderError(
      "Anthropic Console のセッションが期限切れです。cookie を再登録してください。",
    );
  }
  if (!ok) throw new ProviderError(`Anthropic Console API エラー ${status}。`);
  try {
    return applyCreditBaseline(parseAnthropicPrepaidCreditsJson(body), baselineUsd);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("Anthropic のクレジット応答を解析できませんでした。", {
      cause: err,
    });
  }
}

export function createAnthropicProvider(scope: UsageScope): IUsageProvider {
  const strictAccount = scope.kind === "account";
  const piPath = scope.authPath ?? undefined;
  let accountCredentials: ClaudeCredentials | null | undefined;
  // Console cookie の探索は（Chromium 読取を含むため）インスタンス内で 1 回だけ行う。
  let consoleSession: BrowserCookieSession | null | undefined;
  const loadPiCredentials = () => {
    if (!strictAccount) return loadCredentialsFromPi();
    if (!piPath) return null;
    if (accountCredentials === undefined) {
      accountCredentials = loadCredentialsFromPi(piPath);
    }
    return accountCredentials;
  };
  const loadConsoleSession = () => {
    if (consoleSession === undefined) {
      consoleSession = extractAnthropicConsoleSession({ authPath: piPath ?? null });
    }
    return consoleSession;
  };
  const hasApiKey = () => resolveAnthropicApiKey(scope) !== null;
  const loadCreditBaseline = () =>
    piPath ? readAnthropicCreditBaseline(piPath) : null;

  return {
    id: "anthropic",
    name: "Claude",
    isConfigured() {
      if (strictAccount) {
        return (
          loadPiCredentials() !== null || hasApiKey() || loadConsoleSession() !== null
        );
      }
      return (
        loadPiCredentials() !== null ||
        loadCredentials() !== null ||
        hasApiKey() ||
        loadConsoleSession() !== null
      );
    },
    async fetch(signal) {
      // Account scope is deliberately Pi-only. Default scope preserves the
      // existing Pi → Claude CLI fallback for compatibility.
      const recoveryPath = strictAccount ? piPath : piPath ?? piAuthPathFor("anthropic");
      const recoveredPi = recoveryPath ? await recoverAnthropicPiRefresh(recoveryPath) : null;
      const piCreds = recoveredPi ?? loadPiCredentials();
      const usingPi = piCreds !== null;
      if (!strictAccount && !usingPi) retryPendingCredentialPersistence(credentialsPath());
      let creds = strictAccount ? piCreds : piCreds ?? loadCredentials();
      if (!creds) {
        // サブスク OAuth が無い（API キー）アカウントは Console cookie の残高を表示する。
        const session = loadConsoleSession();
        if (session) {
          return fetchCreditsFromConsole(session, signal, loadCreditBaseline());
        }
        throw new ProviderError(missingCredentialsMessage(strictAccount, hasApiKey()));
      }
      if (
        creds.expiresAt &&
        creds.expiresAt.getTime() <= Date.now() + 60_000 &&
        creds.refreshToken
      ) {
        creds =
          (usingPi
            ? await tryRefreshTokensInPi(creds, signal, piPath)
            : await tryRefreshTokens(creds, signal)) ?? creds;
      }
      // claude.ai cookie があればリセット権の残数を付ける（失敗しても使用量表示は続行）。
      // アカウント別 cookie ファイルのみ。既定スコープでは定期取得のたびに
      // Chromium（同期 PowerShell/DPAPI）を読みに行かない。
      const withResetCredits = async (snap: UsageSnapshot): Promise<UsageSnapshot> => {
        if (!strictAccount) return snap;
        const session = loadConsoleSession();
        if (!session || !claudeWebCookieHeader(session)) return snap;
        try {
          const grants = await listClaudeResetGrants(session, signal);
          return { ...snap, rateLimitResetCreditsAvailable: grants.availableCount };
        } catch (err) {
          // 使用量表示は続行するが、無言で 0 件扱いにせず原因をログに残す。
          console.warn(
            "[codexbar] Claude reset grants unavailable:",
            err instanceof Error ? err.message : err,
          );
          return snap;
        }
      };
      try {
        return await withResetCredits(
          await fetchFromApi(creds, signal, { piSource: usingPi }),
        );
      } catch (err) {
        if (err instanceof ProviderError && err.message === "__unauthorized__") {
          const refreshed = usingPi
            ? await tryRefreshTokensInPi(creds, signal, piPath)
            : await tryRefreshTokens(creds, signal);
          if (refreshed) {
            try {
              return await withResetCredits(
                await fetchFromApi(refreshed, signal, { piSource: usingPi }),
              );
            } catch (e2) {
              if (!(e2 instanceof ProviderError && e2.message === "__unauthorized__")) {
                throw e2;
              }
            }
          }
          throw new ProviderError(
            strictAccount
              ? "このアカウントの Claude OAuth トークンが無効か期限切れです。WebUI で再ログインしてください。"
              : usingPi
                ? "Claude の OAuth トークンが無効か期限切れです。WebUI で再ログインしてください。"
                : "Claude の OAuth トークンが無効か期限切れです。`claude` を実行して再認証してください。",
          );
        }
        throw err;
      }
    },
  };
}

export const anthropicProvider = createAnthropicProvider({
  key: "default",
  kind: "default",
  accountId: null,
  accountLabel: null,
  authPath: null,
});
