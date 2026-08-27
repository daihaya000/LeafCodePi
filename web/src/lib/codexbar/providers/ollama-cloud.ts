/**
 * Ollama Cloud usage scraped from https://ollama.com/settings (Netscape cookies).
 */

import { chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteText, clamp, fetchText } from "@/lib/codexbar/utils";
import {
  cookieHeaderFromNetscapeFile,
  cookieHeaderFromNetscapeText,
  findFirstExistingCookieFile,
  netscapeCookieCandidates,
  codexBarConfigDir,
} from "@/lib/codexbar/netscape-cookies";
import {
  ProviderError,
  type IUsageProvider,
  type RateWindow,
  type UsageScope,
  type UsageSnapshot,
} from "@/lib/codexbar/types";

const SETTINGS_URL = "https://ollama.com/settings";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const USAGE_METER_RE =
  /aria-label="(Session|Weekly) usage\s+([0-9.]+)%\s+used"/gi;
const RESET_TIME_RE =
  /class="[^"]*local-time[^"]*"\s+data-time="([^"]+)"/gi;
const PLAN_BADGE_RE =
  />\s*Cloud usage\s*<\/span>\s*<span[^>]*>\s*([A-Za-z]+)\s*</i;
const HEADER_EMAIL_RE =
  /id="header-email"[^>]*>\s*([^\s<]+@[^\s<]+)/i;

const DEFAULT_SCOPE: UsageScope = {
  key: "default",
  kind: "default",
  accountId: null,
  accountLabel: null,
  authPath: null,
};

/** アカウント ID をファイル名へ埋め込む前の検証（パストラバーサル防止）。 */
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function defaultOllamaCookiePath(): string {
  return join(codexBarConfigDir(), "ollama_cookies.txt");
}

/** アカウント別 cookie の保存先。ID が不正なら null（呼び出し側で 400 扱い）。 */
export function accountOllamaCookiePath(accountId: string): string | null {
  if (!SAFE_ACCOUNT_ID.test(accountId)) return null;
  return join(codexBarConfigDir(), `ollama_cookies.${accountId}.txt`);
}

const MAX_COOKIE_TEXT_LENGTH = 1_000_000;

function cookieInputError(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/** API ルートから保存する Netscape cookie。cookie 本文は返さず、入力もログへ出さない。 */
export function saveOllamaCookieFile(accountId: string, text: string): void {
  const path = accountOllamaCookiePath(accountId);
  if (!path) throw cookieInputError("アカウントIDが不正です");
  if (typeof text !== "string" || !text.trim()) {
    throw cookieInputError("cookie を入力してください");
  }
  if (text.length > MAX_COOKIE_TEXT_LENGTH) {
    throw cookieInputError("cookie のサイズが大きすぎます");
  }
  if (!cookieHeaderFromNetscapeText(text, "ollama.com")) {
    throw cookieInputError("有効な ollama.com の Netscape cookie が見つかりません");
  }

  atomicWriteText(path, `${text.trim()}\n`);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows では ACL が権限を管理するため chmod が失敗しても保存自体は有効。
  }
}

export function deleteOllamaCookieFile(accountId: string): void {
  const path = accountOllamaCookiePath(accountId);
  if (!path) throw cookieInputError("アカウントIDが不正です");
  try {
    unlinkSync(path);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export function isOllamaCookieConfigured(accountId?: string | null): boolean {
  const path = ollamaCookieFilePath(accountId);
  return path ? cookieHeaderFromNetscapeFile(path, "ollama.com") !== null : false;
}

export function ollamaCookieFilePath(accountId?: string | null): string | null {
  if (accountId) {
    const path = accountOllamaCookiePath(accountId);
    // アカウント指定時は共有 cookie へフォールバックしない
    // （別アカウントの利用量を自分の残量として表示してしまう）
    return path ? findFirstExistingCookieFile([path]) : null;
  }
  const home = homedir();
  return findFirstExistingCookieFile([
    defaultOllamaCookiePath(),
    join(home, "OneDrive", "AI", "AgentUsageChecker", "cookies", "ollama.com_cookies.txt"),
    join(
      home,
      "OneDrive",
      "AI",
      "__old__",
      "AgentUsageChecker",
      "cookies",
      "ollama.com_cookies.txt",
    ),
    ...netscapeCookieCandidates("ollama.com_cookies.txt"),
    ...netscapeCookieCandidates("ollama_cookies.txt"),
  ]);
}

/** Exported for unit tests. */
export function parseOllamaHtml(html: string): {
  windows: RateWindow[];
  plan: string | null;
  accountEmail: string | null;
} {
  const meters = [...html.matchAll(USAGE_METER_RE)];
  const resets = [...html.matchAll(RESET_TIME_RE)];

  const windows: RateWindow[] = [];
  for (let i = 0; i < meters.length; i++) {
    const meter = meters[i];
    const percent = Number(meter[2]);
    if (!Number.isFinite(percent)) continue;

    const isSession = meter[1].toLowerCase() === "session";
    const meterIndex = meter.index ?? 0;
    const nextMeterIndex =
      i + 1 < meters.length ? (meters[i + 1].index ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;

    let resetsAt: Date | null = null;
    for (const reset of resets) {
      const resetIndex = reset.index ?? 0;
      if (resetIndex <= meterIndex || resetIndex >= nextMeterIndex) continue;
      const t = Date.parse(reset[1]);
      if (!Number.isNaN(t)) resetsAt = new Date(t);
      break;
    }

    windows.push({
      id: isSession ? "ollama-session" : "ollama-weekly",
      title: isSession ? "セッション" : "週間",
      usedPercent: clamp(percent, 0, 100),
      resetsAt,
      windowDurationMs: isSession ? null : 7 * 86400_000,
      countsTowardLimit: true,
    });
  }

  let plan: string | null = null;
  const planMatch = PLAN_BADGE_RE.exec(html);
  if (planMatch?.[1]?.trim()) {
    const p = planMatch[1].trim();
    plan = p.charAt(0).toUpperCase() + p.slice(1);
  }

  const emailMatch = HEADER_EMAIL_RE.exec(html);
  const accountEmail = emailMatch?.[1] ?? null;

  return { windows, plan, accountEmail };
}

export function createOllamaCloudProvider(scope: UsageScope): IUsageProvider {
  const accountId = scope.kind === "account" ? scope.accountId : null;
  return {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    isConfigured() {
      return isOllamaCookieConfigured(accountId);
    },
    async fetch(signal) {
      const cookiePath = ollamaCookieFilePath(accountId);
      if (!cookiePath) {
        throw new ProviderError(
          accountId
            ? "このアカウントの Ollama cookie が未登録です。設定画面から ollama.com の cookie（Netscape形式）を登録してください。"
            : `Ollama の cookie ファイルが見つかりません。ollama.com の cookie（Netscape形式）を ${defaultOllamaCookiePath()} にエクスポートしてください。`,
        );
      }

      const cookieHeader = cookieHeaderFromNetscapeFile(cookiePath, "ollama.com");
      if (!cookieHeader) {
        throw new ProviderError(
          "Ollama の cookie ファイルに有効な ollama.com の cookie がありません。再エクスポートしてください。",
        );
      }

      const { status, body, ok } = await fetchText(SETTINGS_URL, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": USER_AGENT,
          Cookie: cookieHeader,
        },
        signal,
      });

      if (status === 401 || status === 403) {
        throw new ProviderError(
          "Ollama のセッションが期限切れです。ollama.com の cookie を再エクスポートしてください。",
        );
      }
      if (!ok) {
        throw new ProviderError(`ollama.com が HTTP ${status} を返しました。`);
      }

      const { windows, plan, accountEmail } = parseOllamaHtml(body);
      if (windows.length === 0) {
        if (
          /\/signin/i.test(body) &&
          !/Cloud usage/i.test(body)
        ) {
          throw new ProviderError(
            "Ollama のセッションが期限切れです。ollama.com の cookie を再エクスポートしてください。",
          );
        }
        throw new ProviderError(
          "Ollama の使用状況を読み取れませんでした。設定ページの構造が変わった可能性があります。",
        );
      }

      return {
        providerId: "ollama-cloud",
        providerName: "Ollama Cloud",
        plan,
        accountEmail,
        windows,
        creditsBalance: null,
        creditsLabel: null,
        creditsEnabled: false,
        creditsTitle: null,
        creditsUsed: null,
        creditsLimit: null,
        sourceLabel: "ollama.com/settings",
        updatedAt: new Date(),
        isStale: false,
      } satisfies UsageSnapshot;
    },
  };
}

export const ollamaCloudProvider: IUsageProvider = createOllamaCloudProvider(DEFAULT_SCOPE);
