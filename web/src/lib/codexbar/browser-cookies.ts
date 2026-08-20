/**
 * Browser / tray cookie extraction for OpenCode Go and Qwen Cloud.
 *
 * Order (CodexBarWin parity):
 * 1. Netscape cookie files under %APPDATA%\\CodexBar (and legacy cokkie/)
 * 2. OpenCodeTray DPAPI credentials via PowerShell ProtectedData
 * 3. Chrome/Edge Cookies SQLite + AES-GCM (Windows, node:sqlite)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildCookieHeader,
  findFirstExistingCookieFile,
  netscapeCookieCandidates,
  parseNetscapeCookieText,
  type NetscapeCookie,
} from "@/lib/codexbar/netscape-cookies";
import {
  chromeExpiryToDate,
  listChromiumBrowserRoots,
  listChromiumProfiles,
  readChromiumCookiesFromProfile,
} from "@/lib/codexbar/chromium-cookies";
import { asRecord } from "@/lib/codexbar/utils";

const OPENCODE_DOMAIN = "opencode.ai";
const QWEN_COOKIE_FILE = "home.qwencloud.com_cookies.txt";
const OPENCODE_TRAY_ENTROPY = "OpenCodeTray.v1";

const QWEN_CLOUD_DOMAINS = [
  "qwencloud.com",
  "home.qwencloud.com",
  "account.qwencloud.com",
];

export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt: Date | null;
};

export type BrowserCookieSession = {
  sourceLabel: string;
  cookies: BrowserCookie[];
};

function isQwenCloudDomain(host: string): boolean {
  const normalized = host.trim().replace(/^\./, "").toLowerCase();
  return QWEN_CLOUD_DOMAINS.some(
    (d) => normalized === d || normalized.endsWith(`.${d}`),
  );
}

function hasQwenAuthCookies(names: Iterable<string>): boolean {
  const set = new Set(names);
  if (set.has("login_qwencloud_ticket")) return true;
  return (
    set.has("login_aliyunid_ticket") &&
    (set.has("login_aliyunid_pk") ||
      set.has("login_current_pk") ||
      set.has("login_aliyunid"))
  );
}

function netscapeToBrowserCookie(c: NetscapeCookie): BrowserCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain.replace(/^\./, ""),
    hostOnly: !c.includeSubdomains,
    path: c.path || "/",
    secure: c.secure,
    expiresAt: c.expiresUtc > 0 ? new Date(c.expiresUtc * 1000) : null,
  };
}

function cookieMatchesRequest(
  cookie: BrowserCookie,
  requestUrl: URL,
  now: Date,
): boolean {
  if (cookie.expiresAt && cookie.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  if (cookie.secure && requestUrl.protocol !== "https:") return false;

  const host = requestUrl.hostname.toLowerCase();
  const domain = cookie.domain.toLowerCase();
  if (cookie.hostOnly) {
    if (host !== domain) return false;
  } else if (host !== domain && !host.endsWith(`.${domain}`)) {
    return false;
  }

  const requestPath = requestUrl.pathname || "/";
  const path = cookie.path || "/";
  if (!requestPath.startsWith(path)) return false;
  if (path.endsWith("/")) return true;
  return (
    requestPath.length === path.length || requestPath[path.length] === "/"
  );
}

/** Select cookies for an HTTPS request URI (scoped Cookie header). */
export function createCookieHeaderForUrl(
  session: BrowserCookieSession,
  requestUri: string,
): string | null {
  let url: URL;
  try {
    url = new URL(requestUri);
  } catch {
    return null;
  }
  if (!url.protocol.startsWith("http")) return null;

  const now = new Date();
  const matched = session.cookies.filter((c) =>
    cookieMatchesRequest(c, url, now),
  );
  // Prefer longest domain / hostOnly / path (same as CodexBarWin)
  const byName = new Map<string, BrowserCookie>();
  for (const c of matched) {
    const prev = byName.get(c.name);
    if (!prev) {
      byName.set(c.name, c);
      continue;
    }
    const better =
      c.domain.length > prev.domain.length ||
      (c.domain.length === prev.domain.length &&
        Number(c.hostOnly) > Number(prev.hostOnly)) ||
      (c.domain.length === prev.domain.length &&
        Number(c.hostOnly) === Number(prev.hostOnly) &&
        c.path.length > prev.path.length);
    if (better) byName.set(c.name, c);
  }
  const parts = [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `${c.name}=${c.value}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

export function parseQwenCloudNetscapeText(
  text: string,
  sourceLabel = "Netscape cookie file",
): BrowserCookieSession | null {
  const now = Math.floor(Date.now() / 1000);
  const cookies = parseNetscapeCookieText(text)
    .filter((c) => !(c.expiresUtc > 0 && c.expiresUtc < now))
    .filter((c) => isQwenCloudDomain(c.domain))
    .filter((c) => c.name.length > 0 && c.value.length > 0)
    .map(netscapeToBrowserCookie);

  if (!hasQwenAuthCookies(cookies.map((c) => c.name))) return null;
  return { sourceLabel, cookies };
}

function qwenNetscapePaths(): string[] {
  const home = homedir();
  const appData =
    process.env.APPDATA || join(home, "AppData", "Roaming");
  return [
    join(home, "OneDrive", "AI", "CodexBarWin", "cokkie", QWEN_COOKIE_FILE),
    join(appData, "CodexBar", "qwencloud_cookies.txt"),
    join(appData, "CodexBar", "cokkie", QWEN_COOKIE_FILE),
    ...netscapeCookieCandidates(QWEN_COOKIE_FILE),
  ];
}

function extractQwenCloudSessionFromChromium(): BrowserCookieSession | null {
  if (process.platform !== "win32") return null;
  for (const browser of listChromiumBrowserRoots()) {
    for (const profile of listChromiumProfiles(browser.userData)) {
      const rows = readChromiumCookiesFromProfile(profile, (host) =>
        isQwenCloudDomain(host),
      );
      if (rows.length === 0) continue;
      const cookies: BrowserCookie[] = rows.map((r) => ({
        name: r.name,
        value: r.value,
        domain: r.hostKey.replace(/^\./, ""),
        hostOnly: !r.hostKey.startsWith("."),
        path: r.path || "/",
        secure: r.isSecure,
        expiresAt: chromeExpiryToDate(r.expiresUtcChrome),
      }));
      if (!hasQwenAuthCookies(cookies.map((c) => c.name))) continue;
      return {
        sourceLabel: `${browser.name} (${profile.split(/[/\\]/).pop()})`,
        cookies,
      };
    }
  }
  return null;
}

/** Netscape first, then Chrome/Edge profile cookies. */
export function extractQwenCloudSession(): BrowserCookieSession | null {
  for (const path of [...new Set(qwenNetscapePaths())]) {
    if (!existsSync(path)) continue;
    try {
      const session = parseQwenCloudNetscapeText(
        readFileSync(path, "utf8"),
        "Netscape cookie file",
      );
      if (session) return session;
    } catch {
      /* try next */
    }
  }
  return extractQwenCloudSessionFromChromium();
}

function extractOpenCodeCookieFromChromium(): string | null {
  if (process.platform !== "win32") return null;
  for (const browser of listChromiumBrowserRoots()) {
    for (const profile of listChromiumProfiles(browser.userData)) {
      const rows = readChromiumCookiesFromProfile(profile, (host) => {
        const d = host.replace(/^\./, "").toLowerCase();
        return d === OPENCODE_DOMAIN || d.endsWith(`.${OPENCODE_DOMAIN}`);
      });
      if (rows.length === 0) continue;
      return rows.map((r) => `${r.name}=${r.value}`).join("; ");
    }
  }
  return null;
}

export function defaultOpenCodeCookiePath(): string {
  const appData =
    process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "CodexBar", "opencode_cookies.txt");
}

export function findOpenCodeNetscapeCookieFile(): string | null {
  return findFirstExistingCookieFile([
    defaultOpenCodeCookiePath(),
    ...netscapeCookieCandidates("opencode.ai_cookies.txt"),
    ...netscapeCookieCandidates("opencode_cookies.txt"),
  ]);
}

export function extractOpenCodeCookieFromNetscape(
  path: string,
): string | null {
  if (!existsSync(path)) return null;
  try {
    const cookies = parseNetscapeCookieText(readFileSync(path, "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const filtered = cookies.filter((c) => {
      if (c.expiresUtc > 0 && c.expiresUtc < now) return false;
      const d = c.domain.replace(/^\./, "").toLowerCase();
      return (
        d === OPENCODE_DOMAIN || d.endsWith(`.${OPENCODE_DOMAIN}`)
      );
    });
    if (filtered.length === 0) return null;
    return buildCookieHeader(filtered);
  } catch {
    return null;
  }
}

function openCodeTrayCredentialsPath(): string {
  const appData =
    process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "OpenCodeTray", "credentials.dpapi");
}

function appliesToOpenCode(domain: string | null | undefined): boolean {
  if (!domain?.trim()) return true;
  const normalized = domain.trim().replace(/^\./, "").toLowerCase();
  return (
    normalized === OPENCODE_DOMAIN ||
    normalized.endsWith(`.${OPENCODE_DOMAIN}`)
  );
}

function buildCookieHeaderFromDpapiJson(root: Record<string, unknown>): string {
  const cookies = root.cookies;
  if (!Array.isArray(cookies)) return "";
  const parts: string[] = [];
  for (const item of cookies) {
    const c = asRecord(item);
    if (!c) continue;
    const name = typeof c.name === "string" ? c.name : null;
    const value = typeof c.value === "string" ? c.value : null;
    const domain = typeof c.domain === "string" ? c.domain : null;
    if (!name || value === null || !appliesToOpenCode(domain)) continue;
    parts.push(`${name}=${value}`);
  }
  return parts.join("; ");
}

/**
 * Decrypt OpenCodeTray credentials.dpapi via PowerShell ProtectedData.
 * Returns workspaceId + Cookie header, or null.
 */
export function loadOpenCodeTrayCredentials(): {
  workspaceId: string | null;
  cookieHeader: string;
} | null {
  if (process.platform !== "win32") return null;
  const path = openCodeTrayCredentialsPath();
  if (!existsSync(path)) return null;

  try {
    const ps = `
Add-Type -AssemblyName System.Security
$b64 = (Get-Content -LiteralPath ${JSON.stringify(path)} -Raw).Trim()
$bytes = [Convert]::FromBase64String($b64)
$entropy = [Text.Encoding]::UTF8.GetBytes(${JSON.stringify(OPENCODE_TRAY_ENTROPY)})
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($plain)
`;
    const json = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    ).trim();
    const root = asRecord(JSON.parse(json));
    if (!root) return null;
    const workspaceId =
      (typeof root.workspace_id === "string" ? root.workspace_id : null) ||
      (typeof root.workspaceId === "string" ? root.workspaceId : null);
    const cookieHeader = buildCookieHeaderFromDpapiJson(root);
    if (!workspaceId && !cookieHeader) return null;
    return { workspaceId, cookieHeader };
  } catch {
    return null;
  }
}

/** OpenCode cookie: OpenCodeTray DPAPI → Netscape → Chrome/Edge Cookies DB. */
export function extractOpenCodeCookieHeader(): string | null {
  const tray = loadOpenCodeTrayCredentials();
  if (tray?.cookieHeader) return tray.cookieHeader;

  const file = findOpenCodeNetscapeCookieFile();
  if (file) {
    const header = extractOpenCodeCookieFromNetscape(file);
    if (header) return header;
  }
  return extractOpenCodeCookieFromChromium();
}

export function hasOpenCodeTrayCredentialsFile(): boolean {
  return existsSync(openCodeTrayCredentialsPath());
}
