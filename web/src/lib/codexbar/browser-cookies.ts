/**
 * Browser / tray cookie extraction for OpenCode Go, Qwen Cloud and the
 * Anthropic Console (credit balance for API-key accounts).
 *
 * Order (CodexBarWin parity):
 * 1. Netscape cookie files under CodexBar config dir (and legacy cokkie/)
 * 2. OpenCodeTray DPAPI credentials via PowerShell ProtectedData (Windows)
 * 3. Chrome/Edge/Chromium Cookies SQLite (Windows DPAPI / Linux secret-tool)
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { roamingConfigDir } from "@/lib/codexbar/app-paths";
import {
  buildCookieHeader,
  codexBarConfigDir,
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

/** Console session cookies live under these domains (claude.com = current Console). */
const ANTHROPIC_CONSOLE_DOMAINS = ["claude.com", "claude.ai", "console.anthropic.com"];
const ANTHROPIC_SESSION_COOKIE = "sessionKey";
const ANTHROPIC_ORG_COOKIE = "lastActiveOrg";

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
  return requestPath.length === path.length || requestPath[path.length] === "/";
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
  const configDir = codexBarConfigDir();
  return [
    join(home, "OneDrive", "AI", "CodexBarWin", "cokkie", QWEN_COOKIE_FILE),
    join(configDir, "qwencloud_cookies.txt"),
    join(configDir, "cokkie", QWEN_COOKIE_FILE),
    ...netscapeCookieCandidates(QWEN_COOKIE_FILE),
  ];
}

function extractQwenCloudSessionFromChromium(): BrowserCookieSession | null {
  for (const browser of listChromiumBrowserRoots()) {
    for (const profile of listChromiumProfiles(browser.userData)) {
      const rows = readChromiumCookiesFromProfile(
        profile,
        (host) => isQwenCloudDomain(host),
        { secretToolApp: browser.secretToolApp },
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

export function isAnthropicConsoleDomain(host: string): boolean {
  const normalized = host.trim().replace(/^\./, "").toLowerCase();
  return ANTHROPIC_CONSOLE_DOMAINS.some(
    (d) => normalized === d || normalized.endsWith(`.${d}`),
  );
}

function hasAnthropicSessionCookie(cookies: readonly BrowserCookie[]): boolean {
  return cookies.some(
    (c) => c.name === ANTHROPIC_SESSION_COOKIE && c.value.length > 0,
  );
}

/** Anthropic Console cookie（sessionKey 必須）。無効なら null。 */
export function parseAnthropicConsoleNetscapeText(
  text: string,
  sourceLabel = "Netscape cookie file",
): BrowserCookieSession | null {
  const now = Math.floor(Date.now() / 1000);
  const cookies = parseNetscapeCookieText(text)
    .filter((c) => !(c.expiresUtc > 0 && c.expiresUtc < now))
    .filter((c) => isAnthropicConsoleDomain(c.domain))
    .filter((c) => c.name.length > 0 && c.value.length > 0)
    .map(netscapeToBrowserCookie);
  if (!hasAnthropicSessionCookie(cookies)) return null;
  return { sourceLabel, cookies };
}

/** 組織 ID は Console が置く lastActiveOrg cookie（無ければ null）。 */
export function readAnthropicConsoleOrgId(
  session: BrowserCookieSession,
): string | null {
  const cookie = session.cookies.find(
    (c) => c.name === ANTHROPIC_ORG_COOKIE && c.value.trim().length > 0,
  );
  return cookie ? cookie.value.trim() : null;
}

export function defaultAnthropicCookiePath(): string {
  return join(codexBarConfigDir(), "anthropic_cookies.txt");
}

/** アカウント別 Console cookie（auth.json と同じディレクトリ）。 */
export function accountAnthropicCookiePath(authPath: string): string {
  return join(dirname(authPath), "anthropic-cookies.txt");
}

function anthropicNetscapePaths(): string[] {
  const configDir = codexBarConfigDir();
  return [
    defaultAnthropicCookiePath(),
    join(configDir, "cokkie", "platform.claude.com_cookies.txt"),
    join(configDir, "cokkie", "claude.ai_cookies.txt"),
    ...netscapeCookieCandidates("platform.claude.com_cookies.txt"),
    ...netscapeCookieCandidates("claude.ai_cookies.txt"),
  ];
}

function chromiumSessionFor(
  matches: (host: string) => boolean,
  hasSessionCookie: (cookies: readonly BrowserCookie[]) => boolean,
): BrowserCookieSession | null {
  for (const browser of listChromiumBrowserRoots()) {
    for (const profile of listChromiumProfiles(browser.userData)) {
      const rows = readChromiumCookiesFromProfile(profile, matches, {
        secretToolApp: browser.secretToolApp,
      });
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
      if (!hasSessionCookie(cookies)) continue;
      return {
        sourceLabel: `${browser.name} (${profile.split(/[/\\]/).pop()})`,
        cookies,
      };
    }
  }
  return null;
}

/**
 * Anthropic Console cookie の解決順:
 * アカウント別ファイル → CodexBar 設定ディレクトリ → Chrome/Edge profile。
 * アカウント指定時に共有 cookie へフォールバックしない（別アカウントの残高を混ぜない）。
 */
export function extractAnthropicConsoleSession(options?: {
  authPath?: string | null;
}): BrowserCookieSession | null {
  const authPath = options?.authPath;
  const paths = authPath
    ? [accountAnthropicCookiePath(authPath)]
    : [...new Set(anthropicNetscapePaths())];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const session = parseAnthropicConsoleNetscapeText(
        readFileSync(path, "utf8"),
        "Netscape cookie file",
      );
      if (session) return session;
    } catch {
      /* try next */
    }
  }
  if (authPath) return null;
  return chromiumSessionFor(isAnthropicConsoleDomain, hasAnthropicSessionCookie);
}

/** TypeSafe Console（console.typesafe.ai）のセッション cookie。組織を跨がないため host-only。 */
const TYPESAFE_CONSOLE_DOMAIN = "console.typesafe.ai";
const TYPESAFE_SESSION_COOKIE = "session_id";
const TYPESAFE_ORG_COOKIE = "organization_id";

export function isTypesafeConsoleDomain(host: string): boolean {
  return host.trim().replace(/^\./, "").toLowerCase() === TYPESAFE_CONSOLE_DOMAIN;
}

function hasTypesafeSessionCookie(cookies: readonly BrowserCookie[]): boolean {
  return cookies.some(
    (c) => c.name === TYPESAFE_SESSION_COOKIE && c.value.length > 0,
  );
}

/** TypeSafe Console cookie（session_id 必須）。無効なら null。 */
export function parseTypesafeConsoleNetscapeText(
  text: string,
  sourceLabel = "Netscape cookie file",
): BrowserCookieSession | null {
  const now = Math.floor(Date.now() / 1000);
  const cookies = parseNetscapeCookieText(text)
    .filter((c) => !(c.expiresUtc > 0 && c.expiresUtc < now))
    .filter((c) => isTypesafeConsoleDomain(c.domain))
    .filter((c) => c.name.length > 0 && c.value.length > 0)
    .map(netscapeToBrowserCookie);
  if (!hasTypesafeSessionCookie(cookies)) return null;
  return { sourceLabel, cookies };
}

/** 組織 ID は Console が置く organization_id cookie（無ければ null）。 */
export function readTypesafeOrgId(
  session: BrowserCookieSession,
): string | null {
  const cookie = session.cookies.find(
    (c) => c.name === TYPESAFE_ORG_COOKIE && c.value.trim().length > 0,
  );
  return cookie ? cookie.value.trim() : null;
}

export function defaultTypesafeCookiePath(): string {
  return join(codexBarConfigDir(), "typesafe_cookies.txt");
}

function typesafeNetscapePaths(): string[] {
  return [
    defaultTypesafeCookiePath(),
    join(codexBarConfigDir(), "cokkie", "console.typesafe.ai_cookies.txt"),
    ...netscapeCookieCandidates("console.typesafe.ai_cookies.txt"),
  ];
}

/**
 * TypeSafe は LeafCode アカウントに属さない共有プロバイダーのため、cookie も
 * アカウント別ではなく単一のデフォルトファイルのみ（Anthropic の account 分岐は無い）。
 * Netscape ファイル → Chrome/Edge profile の順に探す。
 */
export function extractTypesafeConsoleSession(): BrowserCookieSession | null {
  for (const path of [...new Set(typesafeNetscapePaths())]) {
    if (!existsSync(path)) continue;
    try {
      const session = parseTypesafeConsoleNetscapeText(
        readFileSync(path, "utf8"),
      );
      if (session) return session;
    } catch {
      /* try next */
    }
  }
  return chromiumSessionFor(isTypesafeConsoleDomain, hasTypesafeSessionCookie);
}

/** UI で保存した cookie が実残高取得に必要な2項目を満たすか。 */
export function hasTypesafeCookieFile(): boolean {
  try {
    const session = parseTypesafeConsoleNetscapeText(
      readFileSync(defaultTypesafeCookiePath(), "utf8"),
    );
    return session !== null && readTypesafeOrgId(session) !== null;
  } catch {
    return false;
  }
}

/** 貼り付け本文の他サイトcookieを保存しない。残高取得に必要な2項目だけを直列化する。 */
function typesafeCookieFileText(session: BrowserCookieSession): string | null {
  const sessionId = session.cookies.find(
    (cookie) =>
      cookie.name === TYPESAFE_SESSION_COOKIE && cookie.value.length > 0,
  );
  const organizationId = session.cookies.find(
    (cookie) => cookie.name === TYPESAFE_ORG_COOKIE && cookie.value.length > 0,
  );
  if (!sessionId || !organizationId) return null;
  return [
    "# Netscape HTTP Cookie File",
    ...[sessionId, organizationId].map((cookie) => {
      const expiresUtc = cookie.expiresAt
        ? Math.floor(cookie.expiresAt.getTime() / 1000)
        : 0;
      return [
        cookie.hostOnly ? cookie.domain : `.${cookie.domain}`,
        cookie.hostOnly ? "FALSE" : "TRUE",
        cookie.path,
        cookie.secure ? "TRUE" : "FALSE",
        expiresUtc,
        cookie.name,
        cookie.value,
      ].join("\t");
    }),
    "",
  ].join("\n");
}

export function saveTypesafeCookieFile(text: string): void {
  if (!text.trim()) {
    throw Object.assign(new Error("cookie を入力してください"), { status: 400 });
  }
  if (text.length > 1_000_000) {
    throw Object.assign(new Error("cookie のサイズが大きすぎます"), {
      status: 400,
    });
  }
  const session = parseTypesafeConsoleNetscapeText(text);
  const cookieText = session ? typesafeCookieFileText(session) : null;
  if (!cookieText) {
    throw Object.assign(
      new Error(
        "TypeSafe Console（console.typesafe.ai）の session_id と organization_id cookie が必要です",
      ),
      { status: 400 },
    );
  }
  const path = defaultTypesafeCookiePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, cookieText, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACL が権限を管理するため、chmod 失敗は保存エラーにしない。
  }
}

export function deleteTypesafeCookieFile(): void {
  try {
    unlinkSync(defaultTypesafeCookiePath());
  } catch {
    /* already absent */
  }
}

export function saveAccountAnthropicCookieFile(
  authPath: string,
  text: string,
): void {
  if (!text.trim()) {
    throw Object.assign(new Error("cookie を入力してください"), { status: 400 });
  }
  if (text.length > 1_000_000) {
    throw Object.assign(new Error("cookie のサイズが大きすぎます"), {
      status: 400,
    });
  }
  if (!parseAnthropicConsoleNetscapeText(text)) {
    throw Object.assign(
      new Error(
        "有効な Anthropic Console（platform.claude.com）の sessionKey cookie が見つかりません",
      ),
      { status: 400 },
    );
  }
  const path = accountAnthropicCookiePath(authPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text.trim()}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACL が権限を管理するため、chmod 失敗は保存エラーにしない。
  }
}

export function deleteAccountAnthropicCookieFile(authPath: string): void {
  try {
    unlinkSync(accountAnthropicCookiePath(authPath));
  } catch {
    /* already absent */
  }
}

function extractOpenCodeCookieFromChromium(): string | null {
  for (const browser of listChromiumBrowserRoots()) {
    for (const profile of listChromiumProfiles(browser.userData)) {
      const rows = readChromiumCookiesFromProfile(
        profile,
        (host) => {
          const d = host.replace(/^\./, "").toLowerCase();
          return d === OPENCODE_DOMAIN || d.endsWith(`.${OPENCODE_DOMAIN}`);
        },
        { secretToolApp: browser.secretToolApp },
      );
      if (rows.length === 0) continue;
      return rows.map((r) => `${r.name}=${r.value}`).join("; ");
    }
  }
  return null;
}

export function defaultOpenCodeCookiePath(): string {
  return join(codexBarConfigDir(), "opencode_cookies.txt");
}

export function findOpenCodeNetscapeCookieFile(): string | null {
  return findOpenCodeNetscapeCookieFileForPath();
}

export function accountOpenCodeCookiePath(authPath: string): string {
  return join(dirname(authPath), "opencode-cookies.txt");
}

function findOpenCodeNetscapeCookieFileForPath(
  authPath?: string,
): string | null {
  if (authPath) {
    const path = accountOpenCodeCookiePath(authPath);
    return existsSync(path) ? path : null;
  }
  return findFirstExistingCookieFile([
    defaultOpenCodeCookiePath(),
    ...netscapeCookieCandidates("opencode.ai_cookies.txt"),
    ...netscapeCookieCandidates("opencode_cookies.txt"),
  ]);
}

export function extractOpenCodeCookieFromNetscape(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return parseOpenCodeNetscapeText(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function parseOpenCodeNetscapeText(text: string): string | null {
  const cookies = parseNetscapeCookieText(text);
  const now = Math.floor(Date.now() / 1000);
  const filtered = cookies.filter((c) => {
    if (c.expiresUtc > 0 && c.expiresUtc < now) return false;
    const d = c.domain.replace(/^\./, "").toLowerCase();
    return d === OPENCODE_DOMAIN || d.endsWith(`.${OPENCODE_DOMAIN}`);
  });
  return filtered.length > 0 ? buildCookieHeader(filtered) : null;
}

export function saveAccountOpenCodeCookieFile(
  authPath: string,
  text: string,
): void {
  if (!text.trim()) {
    throw Object.assign(new Error("cookie を入力してください"), {
      status: 400,
    });
  }
  if (text.length > 1_000_000) {
    throw Object.assign(new Error("cookie のサイズが大きすぎます"), {
      status: 400,
    });
  }
  if (!parseOpenCodeNetscapeText(text)) {
    throw Object.assign(
      new Error("有効な opencode.ai の Netscape cookie が見つかりません"),
      { status: 400 },
    );
  }
  const path = accountOpenCodeCookiePath(authPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text.trim()}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACL が権限を管理するため、chmod 失敗は保存エラーにしない。
  }
}

export function deleteAccountOpenCodeCookieFile(authPath: string): void {
  try {
    unlinkSync(accountOpenCodeCookiePath(authPath));
  } catch {
    /* already absent */
  }
}

function openCodeTrayCredentialsPath(): string {
  return join(roamingConfigDir(), "OpenCodeTray", "credentials.dpapi");
}

function appliesToOpenCode(domain: string | null | undefined): boolean {
  if (!domain?.trim()) return true;
  const normalized = domain.trim().replace(/^\./, "").toLowerCase();
  return (
    normalized === OPENCODE_DOMAIN || normalized.endsWith(`.${OPENCODE_DOMAIN}`)
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
export function extractOpenCodeCookieHeader(options?: {
  authPath?: string | null;
}): string | null {
  if (options?.authPath) {
    const file = findOpenCodeNetscapeCookieFileForPath(options.authPath);
    return file ? extractOpenCodeCookieFromNetscape(file) : null;
  }
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
