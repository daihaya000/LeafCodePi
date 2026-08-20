/**
 * Netscape HTTP Cookie File helpers (CodexBarWin BrowserCookieExtractor / Ollama port).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type NetscapeCookie = {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  /** Unix seconds; 0 = session cookie. */
  expiresUtc: number;
  name: string;
  value: string;
  httpOnly: boolean;
};

export function codexBarConfigDir(): string {
  const appData =
    process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "CodexBar");
}

/** Candidate Netscape cookie paths under %APPDATA%\\CodexBar and legacy OneDrive layouts. */
export function netscapeCookieCandidates(fileName: string): string[] {
  const home = homedir();
  const appData = codexBarConfigDir();
  const candidates = [
    join(appData, fileName),
    join(appData, "cokkie", fileName),
    join(home, "OneDrive", "AI", "CodexBarWin", "cokkie", fileName),
    join(home, "OneDrive", "AI", "CodexBar", "cokkie", fileName),
    join(home, "OneDrive", "AI", "AgentUsageChecker", "cookies", fileName),
    join(
      home,
      "OneDrive",
      "AI",
      "__old__",
      "AgentUsageChecker",
      "cookies",
      fileName,
    ),
  ];
  return [...new Set(candidates)];
}

export function findFirstExistingCookieFile(
  candidates: string[],
): string | null {
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Parse Netscape cookie file text (supports `#HttpOnly_` lines). */
export function parseNetscapeCookieText(text: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    let line = rawLine.trim();
    let httpOnly = false;
    if (line.toLowerCase().startsWith("#httponly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    let fields = line.split("\t");
    if (fields.length < 7) {
      fields = line.split(/\s+/).filter(Boolean);
    }
    if (fields.length < 7) continue;

    const expiresUtc = Number(fields[4]);
    if (!Number.isFinite(expiresUtc)) continue;

    const domain = fields[0].replace(/^\./, "").trim();
    const name = fields[5].trim();
    const value = fields[6];
    if (!domain || !name) continue;

    cookies.push({
      domain,
      includeSubdomains: fields[1].toUpperCase() === "TRUE",
      path: fields[2]?.startsWith("/") ? fields[2] : "/",
      secure: fields[3].toUpperCase() === "TRUE",
      expiresUtc,
      name,
      value,
      httpOnly,
    });
  }
  return cookies;
}

export function parseNetscapeCookieFile(path: string): NetscapeCookie[] {
  return parseNetscapeCookieText(readFileSync(path, "utf8"));
}

function domainMatches(
  cookieDomain: string,
  targetDomain: string,
  includeSubdomains: boolean,
): boolean {
  const c = cookieDomain.replace(/^\./, "").toLowerCase();
  const t = targetDomain.replace(/^\./, "").toLowerCase();
  if (c === t) return true;
  if (includeSubdomains && t.endsWith(`.${c}`)) return true;
  // Host cookie for parent when filtering by apex domain (e.g. ollama.com)
  if (c === t || c.endsWith(`.${t}`)) return true;
  return false;
}

/**
 * Filter cookies for a target host/domain, skipping expired entries.
 * `nowUnix` defaults to current UTC seconds (injectable for tests).
 */
export function filterCookiesForDomain(
  cookies: NetscapeCookie[],
  targetDomain: string,
  nowUnix: number = Math.floor(Date.now() / 1000),
): NetscapeCookie[] {
  return cookies.filter((c) => {
    if (c.expiresUtc > 0 && c.expiresUtc < nowUnix) return false;
    return domainMatches(c.domain, targetDomain, c.includeSubdomains);
  });
}

/** Build `Cookie` header from name=value pairs (order preserved). */
export function buildCookieHeader(cookies: NetscapeCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Load Netscape file(s), keep unexpired cookies matching domain, return header
 * or null when empty.
 */
export function cookieHeaderFromNetscapeFile(
  path: string,
  targetDomain: string,
  nowUnix?: number,
): string | null {
  const cookies = filterCookiesForDomain(
    parseNetscapeCookieFile(path),
    targetDomain,
    nowUnix,
  );
  if (cookies.length === 0) return null;
  return buildCookieHeader(cookies);
}

export function cookieHeaderFromNetscapeText(
  text: string,
  targetDomain: string,
  nowUnix?: number,
): string | null {
  const cookies = filterCookiesForDomain(
    parseNetscapeCookieText(text),
    targetDomain,
    nowUnix,
  );
  if (cookies.length === 0) return null;
  return buildCookieHeader(cookies);
}
