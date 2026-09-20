/**
 * OpenCode Go usage from the Console status API (cookie + workspace id).
 *
 * Credential order: OpenCodeTray DPAPI → Netscape cookies + config workspace id.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ProviderError,
  type IUsageProvider,
  type RateWindow,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import type { UsageScope } from "@/lib/codexbar/types";
import {
  asRecord,
  atomicWriteText,
  clamp,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";
import {
  defaultOpenCodeCookiePath,
  extractOpenCodeCookieHeader,
  findOpenCodeNetscapeCookieFile,
  hasOpenCodeTrayCredentialsFile,
  loadOpenCodeTrayCredentials,
} from "@/lib/codexbar/browser-cookies";
import {
  loadCodexBarConfig,
  readConfigString,
  updateCodexBarConfig,
} from "@/lib/codexbar/codexbar-config";

const FETCH_TIMEOUT_MS = 120_000;

type OpenCodeCredentials = {
  workspaceId: string | null;
  cookieHeader: string;
};

function accountOpenCodeGoConfigPath(authPath: string): string {
  return join(dirname(authPath), "opencode-go.json");
}

export function readAccountOpenCodeGoWorkspace(
  authPath: string,
): string | null {
  try {
    if (!existsSync(accountOpenCodeGoConfigPath(authPath))) return null;
    const root = JSON.parse(
      readFileSync(accountOpenCodeGoConfigPath(authPath), "utf8"),
    ) as {
      workspaceId?: unknown;
    };
    return typeof root.workspaceId === "string" && root.workspaceId.trim()
      ? root.workspaceId.trim()
      : null;
  } catch {
    return null;
  }
}

export function writeAccountOpenCodeGoWorkspace(
  authPath: string,
  workspaceId: string,
): void {
  const path = accountOpenCodeGoConfigPath(authPath);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteText(path, `${JSON.stringify({ workspaceId }, null, 2)}\n`);
}

function getWorkspaceIdFromConfig(authPath: string | null): string | null {
  if (authPath) return readAccountOpenCodeGoWorkspace(authPath);
  return readConfigString(loadCodexBarConfig(), "openCodeGoWorkspaceId");
}

function persistWorkspaceId(
  workspaceId: string,
  authPath: string | null,
): void {
  if (authPath) {
    try {
      writeAccountOpenCodeGoWorkspace(authPath, workspaceId);
    } catch {
      /* non-fatal */
    }
    return;
  }
  try {
    const current = getWorkspaceIdFromConfig(null);
    if (current === workspaceId) return;
    updateCodexBarConfig({ openCodeGoWorkspaceId: workspaceId });
  } catch {
    /* non-fatal */
  }
}

function loadCredentials(
  authPath: string | null,
  accountScoped: boolean,
): OpenCodeCredentials | null {
  if (accountScoped) {
    if (!authPath) return null;
    const cookieHeader = extractOpenCodeCookieHeader({ authPath });
    if (!cookieHeader) return null;
    return {
      workspaceId: getWorkspaceIdFromConfig(authPath),
      cookieHeader,
    };
  }
  const tray = loadOpenCodeTrayCredentials();
  if (tray?.cookieHeader) {
    return {
      workspaceId: tray.workspaceId ?? getWorkspaceIdFromConfig(null),
      cookieHeader: tray.cookieHeader,
    };
  }

  const cookieHeader = extractOpenCodeCookieHeader();
  if (!cookieHeader) return null;
  return {
    workspaceId: getWorkspaceIdFromConfig(null),
    cookieHeader,
  };
}

function isLoginPage(html: string): boolean {
  return (
    /Sign in to OpenCode/i.test(html) || /action="\/auth\/login"/i.test(html)
  );
}

function readHydrationNumber(text: string, key: string): number | null {
  const match = new RegExp(`${key}:(-?\\d+(?:\\.\\d+)?)`).exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Exported for unit tests. */
export function parseOpenCodeGoWindow(
  html: string,
  key: string,
  id: string,
  title: string,
  now: Date = new Date(),
): RateWindow | null {
  const match = new RegExp(`${key}:\\$R\\[\\d+\\]=\\{(?<data>[^}]*)\\}`).exec(
    html,
  );
  if (!match?.groups?.data) return null;

  const data = match.groups.data;
  const used = readHydrationNumber(data, "usagePercent");
  const resetInSeconds = readHydrationNumber(data, "resetInSec");
  if (used === null || resetInSeconds === null) return null;

  const resetAt = new Date(now.getTime() + Math.max(0, resetInSeconds) * 1000);
  return {
    id,
    title,
    usedPercent: clamp(used, 0, 100),
    resetsAt: resetAt,
    windowDurationMs: null,
    countsTowardLimit: true,
  };
}

/** Exported for unit tests. */
export function parseOpenCodeGoHtml(
  html: string,
  now: Date = new Date(),
): { windows: RateWindow[]; accountEmail: string | null } {
  const windows: RateWindow[] = [];
  const rolling = parseOpenCodeGoWindow(
    html,
    "rollingUsage",
    "opencode-go-rolling",
    "ローリング",
    now,
  );
  const weekly = parseOpenCodeGoWindow(
    html,
    "weeklyUsage",
    "opencode-go-weekly",
    "週間",
    now,
  );
  const monthly = parseOpenCodeGoWindow(
    html,
    "monthlyUsage",
    "opencode-go-monthly",
    "月間",
    now,
  );
  if (rolling) windows.push(rolling);
  if (weekly) windows.push(weekly);
  if (monthly) windows.push(monthly);

  const emails = [
    ...html.matchAll(
      /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi,
    ),
  ].map((m) => m[0]);
  const unique = [...new Set(emails.map((e) => e.toLowerCase()))];
  const accountEmail =
    unique.length === 1
      ? (emails.find((e) => e.toLowerCase() === unique[0]) ?? null)
      : null;

  return { windows, accountEmail };
}

function readOpenCodeGoDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseOpenCodeGoMeter(
  value: unknown,
  id: string,
  title: string,
  fallbackResetAt: Date | null,
  fallbackStartsAt: Date | null = null,
): RateWindow | null {
  const meter = asRecord(value);
  if (!meter) return null;
  const limit = flexibleNumber(meter.limitMicroCents);
  const used = flexibleNumber(meter.usedMicroCents);
  if (limit === null || limit <= 0 || used === null) return null;

  const startsAt = readOpenCodeGoDate(meter.startsAt) ?? fallbackStartsAt;
  const resetsAt = readOpenCodeGoDate(meter.resetsAt) ?? fallbackResetAt;
  return {
    id,
    title,
    usedPercent: clamp((used / limit) * 100, 0, 100),
    resetsAt,
    windowDurationMs:
      startsAt && resetsAt
        ? Math.max(0, resetsAt.getTime() - startsAt.getTime())
        : null,
    countsTowardLimit: true,
  };
}

/** Exported for unit tests. Parses the current Console `/api/go/status` response. */
export function parseOpenCodeGoStatus(
  payload: string,
): { windows: RateWindow[] } {
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(payload));
  } catch {
    return { windows: [] };
  }
  if (!root) return { windows: [] };

  const access = asRecord(root.access);
  const meters = asRecord(access?.meters);
  if (!meters) return { windows: [] };
  const monthlyStartsAt = readOpenCodeGoDate(access?.startsAt);
  const monthlyResetAt = readOpenCodeGoDate(access?.endsAt);
  const windows = [
    parseOpenCodeGoMeter(
      meters.fiveHour,
      "opencode-go-rolling",
      "ローリング",
      null,
    ),
    parseOpenCodeGoMeter(meters.week, "opencode-go-weekly", "週間", null),
    parseOpenCodeGoMeter(
      meters.month,
      "opencode-go-monthly",
      "月間",
      monthlyResetAt,
      monthlyStartsAt,
    ),
  ].filter((window): window is RateWindow => window !== null);
  return { windows };
}

async function autoDetectWorkspaceId(
  cookieHeader: string,
  signal?: AbortSignal,
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    try {
      const { status, body, ok } = await fetchText("https://opencode.ai/go", {
        headers: {
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "CodexBar/1.0",
          Cookie: cookieHeader,
        },
        timeoutMs: FETCH_TIMEOUT_MS,
        signal,
        redirect: "follow",
      });
      // Node fetch doesn't expose final URL easily; parse HTML/body redirects.
      const fromBody =
        /\/workspace\/([a-zA-Z0-9_-]+)/.exec(body) ??
        /\/console\/((?:wrk|org)_[a-zA-Z0-9_-]+)\/go/.exec(body);
      if (fromBody) return fromBody[1];
      if (!ok && status !== 302 && status !== 301) continue;
    } catch {
      /* retry */
    }
  }
  return null;
}

export function createOpenCodeGoProvider(scope: UsageScope): IUsageProvider {
  const accountScoped = scope.kind === "account";
  const authPath = accountScoped ? scope.authPath : null;
  return {
    id: "opencode-go",
    name: "OpenCode",
    isConfigured() {
      if (accountScoped) {
        return authPath !== null && extractOpenCodeCookieHeader({ authPath }) !== null;
      }
      if (hasOpenCodeTrayCredentialsFile()) return true;
      if (findOpenCodeNetscapeCookieFile()) return true;
      return extractOpenCodeCookieHeader() !== null;
    },
    async fetch(signal) {
      const credentials = loadCredentials(authPath, accountScoped);
      if (!credentials) {
        throw new ProviderError(
          accountScoped
            ? "このアカウントの OpenCode Go Cookie が見つかりません。"
            : "OpenCode Go の認証情報が見つかりません。\n" +
                "1. Chrome/Edge で opencode.ai にログインし、Netscape cookie をエクスポート\n" +
                `2. または workspace ID を CodexBar config.json の openCodeGoWorkspaceId に設定\n` +
                `3. cookie を ${defaultOpenCodeCookiePath()} に配置`,
        );
      }

      if (!credentials.cookieHeader) {
        throw new ProviderError(
          "OpenCode Go の Cookie が取得できませんでした。opencode.ai にブラウザでログインしてから再試行してください。",
        );
      }

      let workspaceId = credentials.workspaceId;
      if (!workspaceId) {
        const wsId = await autoDetectWorkspaceId(
          credentials.cookieHeader,
          signal,
        );
        if (!wsId) {
          throw new ProviderError("workspace ID が不明です");
        }
        workspaceId = wsId;
        persistWorkspaceId(wsId, authPath);
      }

      const pageUrl = `https://opencode.ai/console/${encodeURIComponent(workspaceId)}/go`;
      let status: number;
      let body: string;
      try {
        const res = await fetchText(
          "https://opencode.ai/console/api/go/status",
          {
            headers: {
              Accept: "application/json",
              "Accept-Language": "en-US,en;q=0.9",
              "User-Agent": "CodexBar/1.0",
              Referer: pageUrl,
              Cookie: credentials.cookieHeader,
              "x-org-id": workspaceId,
            },
            timeoutMs: FETCH_TIMEOUT_MS,
            signal,
          },
        );
        status = res.status;
        body = res.body;
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || /aborted/i.test(err.message))
        ) {
          if (signal?.aborted) throw err;
          throw new ProviderError("OpenCode Go への接続がタイムアウトしました");
        }
        throw err;
      }

      if (status === 401 || status === 403 || isLoginPage(body)) {
        throw new ProviderError(
          "OpenCode Go のセッションが期限切れです。opencode.ai にブラウザで再ログインしてから再試行してください。",
        );
      }
      if (status < 200 || status >= 300) {
        throw new ProviderError(`OpenCode Go が HTTP ${status} を返しました。`);
      }

      const { windows } = parseOpenCodeGoStatus(body);
      if (windows.length === 0) {
        throw new ProviderError(
          "OpenCode Go の使用状況を読み取れませんでした。ページ構造が変わった可能性があります。",
        );
      }

      return {
        providerId: "opencode-go",
        providerName: "OpenCode",
        plan: "Go",
        accountEmail: null,
        windows,
        creditsBalance: null,
        creditsLabel: null,
        creditsEnabled: false,
        creditsTitle: null,
        creditsUsed: null,
        creditsLimit: null,
        sourceLabel: "OpenCode Console API",
        updatedAt: new Date(),
        isStale: false,
        rateLimitResetCreditsAvailable: null,
      } satisfies UsageSnapshot;
    },
  };
}

export const opencodeGoProvider: IUsageProvider = createOpenCodeGoProvider({
  key: "default",
  kind: "default",
  accountId: null,
  accountLabel: null,
  authPath: null,
});
