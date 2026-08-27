import { copyFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

/** Node's built-in fetch can give up before slow Windows network paths respond. */
const slowNetworkAgent = new Agent({
  connectTimeout: 30_000,
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 1_000,
});

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function flexibleNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function windowTitle(durationMs: number | null, isPrimary: boolean): string {
  if (durationMs === null) return isPrimary ? "セッション" : "週間";
  const minutes = durationMs / 60_000;
  if (minutes >= 10000 && minutes <= 10160) return "週間";
  if (Math.abs(minutes - 300) < 30) return "5時間";
  if (minutes % 1440 === 0) return `${Math.floor(minutes / 1440)}日`;
  if (minutes % 60 === 0) return `${Math.floor(minutes / 60)}時間`;
  return `${Math.floor(minutes)}分`;
}

export function creditsFillPercent(
  used: number | null,
  limit: number | null,
): number | null {
  if (limit === null || !(limit > 0)) return null;
  return clamp(((used ?? 0) / limit) * 100, 0, 100);
}

export function representativePercent(snapshot: {
  windows: { usedPercent: number; countsTowardLimit: boolean }[];
  creditsEnabled: boolean;
  creditsUsed: number | null;
  creditsLimit: number | null;
}): number | null {
  const counting = snapshot.windows.filter((w) => w.countsTowardLimit);
  const effective = counting.length > 0 ? counting : snapshot.windows;
  let percent: number | null =
    effective.length > 0 ? Math.max(...effective.map((w) => w.usedPercent)) : null;
  const credits = snapshot.creditsEnabled
    ? creditsFillPercent(snapshot.creditsUsed, snapshot.creditsLimit)
    : null;
  if (credits !== null && (percent === null || credits > percent)) percent = credits;
  return percent;
}

export const LIMIT_THRESHOLD_PERCENT = 90;
export const MAXED_THRESHOLD_PERCENT = 99.5;

export function isLimited(percent: number): boolean {
  return percent >= LIMIT_THRESHOLD_PERCENT;
}

export function isMaxed(percent: number): boolean {
  return percent >= MAXED_THRESHOLD_PERCENT;
}

/** Decode JWT payload (no verify). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    payload = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return asRecord(JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
  } catch {
    return null;
  }
}

/**
 * Atomically write text (tmp + replace). Best-effort on Windows when rename
 * cannot overwrite an existing file.
 */
export function atomicWriteText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.leafcode-tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    try {
      copyFileSync(tmp, filePath);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

export function cleanApiKey(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : null;
}

function isConnectTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("cause" in error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  return (
    !!cause &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

type TextResponse = Pick<Response, "status" | "ok" | "text">;

export async function fetchText(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: string; ok: boolean }> {
  const { timeoutMs = 30_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const parent = rest.signal;
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    let res: TextResponse;
    try {
      res = await fetch(url, { ...rest, signal: ctrl.signal });
    } catch (error) {
      if (!isConnectTimeout(error)) throw error;
      const fallbackInit: UndiciRequestInit = {
        ...(rest as UndiciRequestInit),
        signal: ctrl.signal,
        dispatcher: slowNetworkAgent,
      };
      res = await undiciFetch(url, fallbackInit);
    }
    const body = await res.text();
    return { status: res.status, body, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}
