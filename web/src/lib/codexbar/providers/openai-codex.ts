/**
 * Codex (ChatGPT) usage via wham/usage + OAuth refresh.
 * Auth: ~/.codex/auth.json (CODEX_HOME). Simple session-log fallback on API failure.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  decodeJwtPayload,
  fetchText,
  flexibleNumber,
  windowTitle,
} from "@/lib/codexbar/utils";
import {
  readPiOAuthTokens,
  writeBackPiOAuthTokens,
} from "@/lib/codexbar/pi-auth";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type CodexAuth = {
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  emailFromJwt: string | null;
  planFromJwt: string | null;
};

function codexHome(): string {
  const env = process.env.CODEX_HOME;
  if (env?.trim()) return env.trim();
  return join(homedir(), ".codex");
}

function authPath(): string {
  return join(codexHome(), "auth.json");
}

function prettyPlan(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  switch (raw) {
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "team":
      return "Team";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    case "free":
      return "Free";
    case "edu":
    case "education":
      return "Education";
    default:
      return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
}

function parseJwtClaims(jwt: string): { email: string | null; plan: string | null } {
  const root = decodeJwtPayload(jwt);
  if (!root) return { email: null, plan: null };
  const email = typeof root.email === "string" ? root.email : null;
  let plan: string | null = null;
  const authClaim = asRecord(root["https://api.openai.com/auth"]);
  if (authClaim && typeof authClaim.chatgpt_plan_type === "string") {
    plan = prettyPlan(authClaim.chatgpt_plan_type);
  }
  return { email, plan };
}

function loadAuth(path = authPath()): CodexAuth | null {
  try {
    const root = asRecord(JSON.parse(readFileSync(path, "utf8")));
    const tokens = asRecord(root?.tokens);
    if (!tokens) return null;
    const accessToken =
      typeof tokens.access_token === "string" ? tokens.access_token : null;
    if (!accessToken) return null;
    const refreshToken =
      typeof tokens.refresh_token === "string" ? tokens.refresh_token : null;
    const accountId =
      typeof tokens.account_id === "string" ? tokens.account_id : null;
    let email: string | null = null;
    let plan: string | null = null;
    if (typeof tokens.id_token === "string") {
      ({ email, plan } = parseJwtClaims(tokens.id_token));
    }
    return {
      accessToken,
      refreshToken,
      accountId,
      emailFromJwt: email,
      planFromJwt: plan,
    };
  } catch {
    return null;
  }
}

function persistTokens(
  accessToken: string,
  idToken: string | null,
  refreshToken: string,
): void {
  const path = authPath();
  try {
    const node = asRecord(JSON.parse(readFileSync(path, "utf8"))) ?? {};
    const tokens = asRecord(node.tokens) ?? {};
    tokens.access_token = accessToken;
    if (idToken) tokens.id_token = idToken;
    tokens.refresh_token = refreshToken;
    node.tokens = tokens;
    node.last_refresh = new Date().toISOString();
    atomicWriteText(path, JSON.stringify(node, null, 2));
  } catch {
    /* best effort */
  }
}

async function tryRefreshTokens(
  auth: CodexAuth,
  signal?: AbortSignal,
): Promise<CodexAuth | null> {
  if (!auth.refreshToken) return null;
  try {
    const { ok, body } = await fetchText(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        scope: "openid profile email",
      }),
      signal,
    });
    if (!ok) return null;
    const root = asRecord(JSON.parse(body));
    const accessToken =
      typeof root?.access_token === "string" ? root.access_token : null;
    if (!accessToken) return null;
    const idToken = typeof root?.id_token === "string" ? root.id_token : null;
    const refreshToken =
      typeof root?.refresh_token === "string"
        ? root.refresh_token
        : auth.refreshToken;
    persistTokens(accessToken, idToken, refreshToken);
    return loadAuth();
  } catch {
    return null;
  }
}

function addApiWindow(
  windows: RateWindow[],
  rateLimit: Record<string, unknown>,
  key: string,
  id: string,
  isPrimary: boolean,
): void {
  const win = asRecord(rateLimit[key]);
  if (!win) return;
  const used = flexibleNumber(win.used_percent) ?? 0;
  let resetsAt: Date | null = null;
  const resetUnix = flexibleNumber(win.reset_at);
  if (resetUnix !== null) resetsAt = new Date(resetUnix * 1000);
  let durationMs: number | null = null;
  const secs = flexibleNumber(win.limit_window_seconds);
  if (secs !== null) durationMs = secs * 1000;
  windows.push({
    id,
    title: windowTitle(durationMs, isPrimary),
    usedPercent: clamp(used, 0, 100),
    resetsAt,
    windowDurationMs: durationMs,
    countsTowardLimit: true,
  });
}

function parseUsageBody(root: Record<string, unknown>, auth: CodexAuth): UsageSnapshot {
  const windows: RateWindow[] = [];
  const rateLimit = asRecord(root.rate_limit);
  if (rateLimit) {
    addApiWindow(windows, rateLimit, "primary_window", "codex-primary", true);
    addApiWindow(windows, rateLimit, "secondary_window", "codex-secondary", false);
  }
  let plan: string | null = null;
  if (typeof root.plan_type === "string") plan = prettyPlan(root.plan_type);

  let credits: number | null = null;
  const creditsEl = asRecord(root.credits);
  if (creditsEl) credits = flexibleNumber(creditsEl.balance);

  return {
    providerId: "openai-codex",
    providerName: "Codex",
    plan: plan ?? auth.planFromJwt,
    accountEmail: auth.emailFromJwt,
    windows,
    creditsEnabled: credits !== null,
    creditsTitle: credits !== null ? "クレジット" : null,
    creditsBalance: credits,
    creditsUsed: null,
    creditsLimit: null,
    creditsLabel: null,
    sourceLabel: "OAuth API",
    updatedAt: new Date(),
    isStale: false,
  };
}

function addSessionWindow(
  windows: RateWindow[],
  limits: Record<string, unknown>,
  key: string,
  id: string,
  isPrimary: boolean,
): void {
  const win = asRecord(limits[key]);
  if (!win) return;
  const used = flexibleNumber(win.used_percent) ?? 0;
  let resetsAt: Date | null = null;
  const resetUnix = flexibleNumber(win.resets_at);
  if (resetUnix !== null) resetsAt = new Date(resetUnix * 1000);
  let durationMs: number | null = null;
  const mins = flexibleNumber(win.window_minutes);
  if (mins !== null) durationMs = mins * 60_000;
  windows.push({
    id,
    title: windowTitle(durationMs, isPrimary),
    usedPercent: clamp(used, 0, 100),
    resetsAt,
    windowDurationMs: durationMs,
    countsTowardLimit: true,
  });
}

/** Simple fallback: newest *.jsonl under sessions/ with a rate_limits line. */
function tryLoadFromSessionLogs(): UsageSnapshot | null {
  try {
    const home = codexHome();
    const candidates: { path: string; mtime: number }[] = [];
    for (const dir of [join(home, "sessions"), join(home, "archived_sessions")]) {
      if (!existsSync(/* turbopackIgnore: true */ dir)) continue;
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          try {
            const st = statSync(p);
            if (st.isDirectory()) walk(p);
            else if (name.endsWith(".jsonl")) candidates.push({ path: p, mtime: st.mtimeMs });
          } catch {
            /* ignore */
          }
        }
      };
      walk(dir);
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const file of candidates.slice(0, 10)) {
      let lastMatch: string | null = null;
      const text = readFileSync(file.path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.includes('"rate_limits"')) lastMatch = line;
      }
      if (!lastMatch) continue;
      try {
        const root = asRecord(JSON.parse(lastMatch));
        const payload = asRecord(root?.payload);
        const limits = asRecord(payload?.rate_limits);
        if (!limits) continue;
        const windows: RateWindow[] = [];
        addSessionWindow(windows, limits, "primary", "codex-primary", true);
        addSessionWindow(windows, limits, "secondary", "codex-secondary", false);
        if (windows.length === 0) continue;
        let plan: string | null = null;
        if (typeof limits.plan_type === "string") plan = prettyPlan(limits.plan_type);
        let updatedAt = new Date(file.mtime);
        if (typeof root?.timestamp === "string") {
          const t = Date.parse(root.timestamp);
          if (!Number.isNaN(t)) updatedAt = new Date(t);
        }
        return {
          providerId: "openai-codex",
          providerName: "Codex",
          plan,
          accountEmail: null,
          windows,
          creditsEnabled: false,
          creditsTitle: null,
          creditsBalance: null,
          creditsUsed: null,
          creditsLimit: null,
          creditsLabel: null,
          sourceLabel: "local session log",
          updatedAt,
          isStale: true,
        };
      } catch {
        continue;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Pi の auth.json（既定ストア）から認証を組む。
 * Pi は id_token / email / subscriptionType を保存しないため email・JWT プランは常に null
 * （plan は利用量 API 応答の plan_type から取得する）。
 */
function loadAuthFromPi(path?: string): CodexAuth | null {
  const tokens = readPiOAuthTokens(
    "openai-codex",
    path ? { authPath: path } : undefined,
  );
  if (!tokens) return null;
  return {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    accountId: tokens.accountId,
    emailFromJwt: null,
    planFromJwt: null,
  };
}

/** Pi ストア向けトークンリフレッシュ。成功時は Pi auth.json へマージ書き戻しする。 */
async function tryRefreshTokensInPi(
  auth: CodexAuth,
  signal?: AbortSignal,
  authPathOverride?: string,
): Promise<CodexAuth | null> {
  if (!auth.refreshToken) return null;
  try {
    const { ok, body } = await fetchText(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        scope: "openid profile email",
      }),
      signal,
    });
    if (!ok) return null;
    const root = asRecord(JSON.parse(body));
    const accessToken = typeof root?.access_token === "string" ? root.access_token : null;
    if (!accessToken) return null;
    const refreshToken =
      typeof root?.refresh_token === "string" ? root.refresh_token : auth.refreshToken;
    await writeBackPiOAuthTokens(
      "openai-codex",
      {
        access: accessToken,
        refresh: refreshToken,
      },
      authPathOverride ? { authPath: authPathOverride } : undefined,
    );
    return {
      accessToken,
      refreshToken,
      accountId: auth.accountId,
      emailFromJwt: null,
      planFromJwt: null,
    };
  } catch {
    return null;
  }
}

async function fetchFromApi(
  auth: CodexAuth,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": "CodexBar",
    Accept: "application/json",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  const { status, body, ok } = await fetchText(USAGE_URL, { headers, signal });
  if (status === 401 || status === 403) {
    throw new ProviderError("__unauthorized__");
  }
  if (!ok) throw new ProviderError(`Codex API エラー ${status}。`);
  const root = asRecord(JSON.parse(body));
  if (!root) throw new ProviderError("Codex の応答形式が不正です。");
  return parseUsageBody(root, auth);
}

export function createOpenaiCodexProvider(scope: UsageScope): IUsageProvider {
  const strictAccount = scope.kind === "account";
  const piPath = scope.authPath ?? undefined;
  let accountAuth: CodexAuth | null | undefined;
  const loadPiAuth = () => {
    if (!strictAccount) return loadAuthFromPi();
    if (!piPath) return null;
    if (accountAuth === undefined) accountAuth = loadAuthFromPi(piPath);
    return accountAuth;
  };

  return {
    id: "openai-codex",
    name: "Codex",
    isConfigured() {
      if (strictAccount) return loadPiAuth() !== null;
      return loadPiAuth() !== null || loadAuth() !== null;
    },
    async fetch(signal) {
      // Account scope is deliberately Pi-only. Default scope preserves the
      // existing Pi → Codex CLI fallback for compatibility.
      const piAuth = loadPiAuth();
      const usingPi = piAuth !== null;
      const auth = strictAccount ? piAuth : piAuth ?? loadAuth();
      if (!auth) {
        throw new ProviderError(
          strictAccount
            ? "このアカウントの Codex 認証情報がありません。先に WebUI でログインしてください。"
            : "Codex の認証情報が見つかりません。WebUI の「サブスクでログイン」または `codex` CLI でサインインしてください。",
        );
      }
      try {
        return await fetchFromApi(auth, signal);
      } catch (err) {
        if (err instanceof ProviderError && err.message === "__unauthorized__") {
          const refreshed = usingPi
            ? await tryRefreshTokensInPi(auth, signal, piPath)
            : await tryRefreshTokens(auth, signal);
          if (refreshed) {
            try {
              return await fetchFromApi(refreshed, signal);
            } catch (e2) {
              if (!(e2 instanceof ProviderError && e2.message === "__unauthorized__")) {
                throw e2;
              }
            }
          }
          const local = strictAccount ? null : tryLoadFromSessionLogs();
          if (local) return local;
          throw new ProviderError(
            strictAccount
              ? "このアカウントの Codex OAuth トークンが無効か期限切れです。WebUI で再ログインしてください。"
              : "Codex の OAuth トークンが無効か期限切れです。`codex` を実行して再認証してください。",
          );
        }
        if (err instanceof ProviderError) throw err;
        const local = strictAccount ? null : tryLoadFromSessionLogs();
        if (local) return local;
        throw new ProviderError(
          `Codex の使用状況取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

export const openaiCodexProvider = createOpenaiCodexProvider({
  key: "default",
  kind: "default",
  accountId: null,
  accountLabel: null,
  authPath: null,
});

/** Exported for unit tests. */
export function parseCodexUsageJson(json: string, auth?: Partial<CodexAuth>): UsageSnapshot {
  const root = asRecord(JSON.parse(json));
  if (!root) throw new ProviderError("invalid");
  return parseUsageBody(root, {
    accessToken: "x",
    refreshToken: null,
    accountId: null,
    emailFromJwt: null,
    planFromJwt: null,
    ...auth,
  });
}
