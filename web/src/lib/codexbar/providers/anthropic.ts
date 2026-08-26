/**
 * Claude Code usage via Anthropic OAuth usage API + token refresh.
 * Auth: ~/.claude/.credentials.json (CLAUDE_CONFIG_DIR).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ProviderError,
  type IUsageProvider,
  type RateWindow,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import {
  asRecord,
  atomicWriteText,
  clamp,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";
import {
  readPiOAuthTokens,
  writeBackPiOAuthTokens,
} from "@/lib/codexbar/pi-auth";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
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

function loadCredentials(): ClaudeCredentials | null {
  try {
    const root = asRecord(JSON.parse(readFileSync(credentialsPath(), "utf8")));
    const oauth = asRecord(root?.claudeAiOauth);
    if (!oauth) return null;
    const accessToken =
      typeof oauth.accessToken === "string" ? oauth.accessToken : null;
    if (!accessToken) return null;
    const refreshToken =
      typeof oauth.refreshToken === "string" ? oauth.refreshToken : null;
    let expiresAt: Date | null = null;
    if (typeof oauth.expiresAt === "number") {
      expiresAt = new Date(oauth.expiresAt);
    }
    const subscriptionType =
      typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null;
    return { accessToken, refreshToken, expiresAt, subscriptionType };
  } catch {
    return null;
  }
}

function persistTokens(
  accessToken: string,
  refreshToken: string,
  expiresAt: Date,
): void {
  const path = credentialsPath();
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

async function tryRefreshTokens(
  creds: ClaudeCredentials,
  signal?: AbortSignal,
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
    persistTokens(accessToken, refreshToken, expiresAt);
    return loadCredentials();
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
  };
}

/**
 * Pi の auth.json（既定ストア）から認証を組む。Pi は subscriptionType を保存しないため
 * プラン表示は縮退（null）。email も ~/.claude.json 由来のため Pi 経由では出さない。
 */
function loadCredentialsFromPi(): ClaudeCredentials | null {
  const tokens = readPiOAuthTokens("anthropic");
  if (!tokens) return null;
  return {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: tokens.expires ? new Date(tokens.expires) : null,
    subscriptionType: null,
  };
}

/** Pi ストア向けトークンリフレッシュ。成功時は Pi auth.json へマージ書き戻しする。 */
async function tryRefreshTokensInPi(
  creds: ClaudeCredentials,
  signal?: AbortSignal,
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
    writeBackPiOAuthTokens("anthropic", {
      access: accessToken,
      refresh: refreshToken,
      expires: Date.now() + expiresIn * 1000,
    });
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      subscriptionType: null,
    };
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

export const anthropicProvider: IUsageProvider = {
  id: "anthropic",
  name: "Claude",
  isConfigured() {
    // docs/plans/multi-account.md Phase 7: Pi 既定ストアを優先し、無ければ CLI へフォールバック。
    return existsSync(credentialsPath()) || readPiOAuthTokens("anthropic") !== null;
  },
  async fetch(signal) {
    const piCreds = loadCredentialsFromPi();
    const usingPi = piCreds !== null;
    let creds = piCreds ?? loadCredentials();
    if (!creds) {
      throw new ProviderError(
        "Claude の認証情報が見つかりません。WebUI の「サブスクでログイン」または `claude` CLI でサインインしてください。",
      );
    }
    if (
      creds.expiresAt &&
      creds.expiresAt.getTime() <= Date.now() + 60_000 &&
      creds.refreshToken
    ) {
      creds =
        (usingPi
          ? await tryRefreshTokensInPi(creds, signal)
          : await tryRefreshTokens(creds, signal)) ?? creds;
    }
    try {
      return await fetchFromApi(creds, signal, { piSource: usingPi });
    } catch (err) {
      if (err instanceof ProviderError && err.message === "__unauthorized__") {
        const refreshed = usingPi
          ? await tryRefreshTokensInPi(creds, signal)
          : await tryRefreshTokens(creds, signal);
        if (refreshed) {
          try {
            return await fetchFromApi(refreshed, signal, { piSource: usingPi });
          } catch (e2) {
            if (!(e2 instanceof ProviderError && e2.message === "__unauthorized__")) {
              throw e2;
            }
          }
        }
        throw new ProviderError(
          usingPi
            ? "Claude の OAuth トークンが無効か期限切れです。WebUI で再ログインしてください。"
            : "Claude の OAuth トークンが無効か期限切れです。`claude` を実行して再認証してください。",
        );
      }
      throw err;
    }
  },
};
