/** OpenDesign Console balance/Design Plan usage. Runtime API keys cannot authorize billing. */
import { chmodSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { watchConfigurationPath } from "@backend-core/configuration-command.mjs";
import { parseNetscapeCookieText } from "@/lib/codexbar/netscape-cookies";
import { ProviderError, type IUsageProvider, type RateWindow, type UsageScope, type UsageSnapshot } from "@/lib/codexbar/types";
import { asRecord, atomicWriteText, clamp, fetchText, flexibleNumber } from "@/lib/codexbar/utils";

export const OPENDESIGN_CONSOLE_BASE = "https://amr-api.open-design.ai/api";
const COOKIE_HOST = "amr-api.open-design.ai";
type Credentials = { cookies: string; workspaceId: string };
const invalidCookie = () => Object.assign(new Error("OpenDesign の有効な Cookie ヘッダーまたは Netscape cookie を入力してください"), { status: 400 });
const validWorkspace = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Match the actual billing host/path; never send another site's cookies. */
export function parseOpenDesignCookieInput(text: string, now = Date.now()): string | null {
  if (!text.trim() || text.length > 1_000_000) return null;
  const exported = parseNetscapeCookieText(text);
  const header = exported.length ? exported.filter(cookie => {
    const domain = cookie.domain.toLowerCase();
    return (domain === COOKIE_HOST || (domain === "open-design.ai" && cookie.includeSubdomains)) &&
      (cookie.expiresUtc === 0 || cookie.expiresUtc * 1000 > now) &&
      ["/", "/api", "/api/", "/api/v1", "/api/v1/"].includes(cookie.path);
  }).map(cookie => `${cookie.name}=${cookie.value}`).join("; ") : text.trim().replace(/^Cookie:\s*/i, "");
  if (!header || /[^\x20-\x7e]/.test(header)) return null;
  return header.split(";").every(pair => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\s;]*$/.test(pair.trim())) ? header : null;
}

export function accountOpenDesignCookiePath(authPath: string): string {
  return join(dirname(authPath), "opendesign-cookie.json");
}
function loadCredentials(authPath: string | null): Credentials | null {
  if (!authPath) return null;
  try {
    const data = asRecord(JSON.parse(readFileSync(accountOpenDesignCookiePath(authPath), "utf8")));
    if (typeof data?.cookies !== "string" || !validWorkspace(data.workspaceId)) return null;
    const cookies = parseOpenDesignCookieInput(data.cookies);
    return cookies ? { cookies, workspaceId: data.workspaceId } : null;
  } catch { return null; }
}
export function hasOpenDesignCookie(authPath: string): boolean { return loadCredentials(authPath) !== null; }
export function saveOpenDesignCookie(authPath: string, text: string, workspaceId: string): void {
  if (!parseOpenDesignCookieInput(text) || !validWorkspace(workspaceId)) throw invalidCookie();
  const path = accountOpenDesignCookiePath(authPath);
  watchConfigurationPath(path);
  atomicWriteText(path, `${JSON.stringify({ cookies: text.trim(), workspaceId })}\n`, 0o600);
  try { chmodSync(path, 0o600); } catch { /* Windows uses ACLs. */ }
}
export function deleteOpenDesignCookie(authPath: string): void {
  const path = accountOpenDesignCookiePath(authPath);
  watchConfigurationPath(path);
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function jsonRecord(value: string): Record<string, unknown> {
  try { const data = asRecord(JSON.parse(value)); if (data) return data; } catch { /* Normalize below. */ }
  throw new ProviderError("OpenDesign の残量応答形式が不正です。");
}
function parseWindow(value: unknown): RateWindow {
  const data = asRecord(value);
  const limit = flexibleNumber(data?.limitCredits), remaining = flexibleNumber(data?.remainingCredits);
  const duration = flexibleNumber(data?.durationSeconds);
  if (!data || typeof data.policyId !== "string" || limit === null || limit <= 0 || remaining === null || duration === null || duration <= 0) {
    throw new ProviderError("OpenDesign の Design Plan 残量応答形式が不正です。");
  }
  const reset = typeof data.resetsAt === "string" ? new Date(data.resetsAt) : null;
  return { id: data.policyId, title: duration % 86400 === 0 ? `${duration / 86400}日間` : `${duration / 3600}時間`,
    usedPercent: clamp((1 - remaining / limit) * 100, 0, 100),
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset : null,
    windowDurationMs: duration * 1000, countsTowardLimit: true };
}

/** Console fields are decimal USD / remainingCredits, not cents or invented allowances. */
export function parseOpenDesignUsage(balance: Record<string, unknown> | null, usage: Record<string, unknown> | null): UsageSnapshot {
  const balanceUsd = balance ? flexibleNumber(balance.balanceUsd) : null;
  if (balance && balanceUsd === null) throw new ProviderError("OpenDesign の残高が応答にありません。");
  if (usage && (typeof usage.eligible !== "boolean" || (usage.eligible && !Array.isArray(usage.windows)))) throw new ProviderError("OpenDesign の Design Plan 応答形式が不正です。");
  const windows = usage?.eligible === true ? (usage.windows as unknown[]).map(parseWindow)
    .filter(window => window.windowDurationMs === 604800000 || (usage.tier === "go" && window.windowDurationMs === 18000000)) : [];
  if (balanceUsd === null && !windows.length) throw new ProviderError("OpenDesign の残量を取得できませんでした。");
  return { providerId: "opendesign", providerName: "OpenDesign", plan: typeof usage?.tier === "string" ? `Design Plan ${usage.tier}` : null,
    accountEmail: null, windows, creditsEnabled: balanceUsd !== null, creditsTitle: "アカウント残高",
    creditsUsed: null, creditsLimit: null, creditsBalance: balanceUsd, creditsLabel: balanceUsd === null ? null : "USD",
    sourceLabel: "amr-api.open-design.ai/api (cookie)", updatedAt: new Date(), isStale: false,
    rateLimitResetCreditsAvailable: null };
}

async function request(path: string, cookie: string, signal?: AbortSignal, workspaceId?: string) {
  let response: Awaited<ReturnType<typeof fetchText>>;
  try {
    response = await fetchText(`${OPENDESIGN_CONSOLE_BASE}${path}`, {
      headers: { Cookie: cookie, Accept: "application/json", ...(workspaceId ? { "x-vela-workspace-id": workspaceId } : {}) },
      signal, timeoutMs: 10_000, redirect: "error",
    });
  } catch {
    // Transport errors can contain request headers. Do not surface their original message.
    throw new ProviderError(signal?.aborted ? "OpenDesign の残量取得を中止しました。" : "OpenDesign の残量 API と通信できませんでした。");
  }
  if (response.status === 401) throw Object.assign(new ProviderError("OpenDesign の cookie が無効または期限切れです。再登録してください。"), { status: 400 });
  if (response.status === 429) throw new ProviderError("OpenDesign の残量取得がレート制限されました。", { code: "rate_limit" });
  if (!response.ok) throw Object.assign(new ProviderError(`OpenDesign の残量取得に失敗しました (HTTP ${response.status})。`), { httpStatus: response.status });
  return jsonRecord(response.body);
}
async function fetchUsage(credentials: Credentials, signal?: AbortSignal): Promise<UsageSnapshot> {
  const { cookies, workspaceId } = credentials;
  const prefix = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  const optional = async (path: string) => {
    try { return await request(path, cookies, signal, workspaceId); }
    catch (error) {
      // Some memberships expose only a wallet or only a Design Plan. Never invent zero usage.
      if ([403, 404].includes((error as { httpStatus?: number }).httpStatus ?? 0)) return null;
      throw error;
    }
  };
  const [balance, usage] = await Promise.all([optional(`${prefix}/wallet/balance`), optional(`${prefix}/billing/coding-plan-usage`)]);
  return parseOpenDesignUsage(balance, usage);
}

/** Validate before saving and pin the selected workspace; later browser switches cannot change scope. */
export async function validateOpenDesignCookie(text: string, signal?: AbortSignal): Promise<string> {
  const cookies = parseOpenDesignCookieInput(text);
  if (!cookies) throw invalidCookie();
  const current = await request("/v1/workspaces/current", cookies, signal);
  if (!validWorkspace(current.workspaceId)) throw new ProviderError("OpenDesign の workspace を確認できませんでした。");
  await fetchUsage({ cookies, workspaceId: current.workspaceId }, signal);
  return current.workspaceId;
}
export function createOpenDesignUsageProvider(scope: UsageScope): IUsageProvider {
  return { id: "opendesign", name: "OpenDesign", isConfigured: () => loadCredentials(scope.authPath) !== null,
    async fetch(signal) {
      const credentials = loadCredentials(scope.authPath);
      if (!credentials) throw new ProviderError("OpenDesign の残量表示には、このアカウントの cookie 登録が必要です。");
      return fetchUsage(credentials, signal);
    } };
}
export const opendesignProvider = createOpenDesignUsageProvider({ key: "default", kind: "default", accountId: null, accountLabel: null, authPath: null });
