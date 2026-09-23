/**
 * Claude のリセット権（claude.ai「Reset for free」, program=cedar_ember）。
 *
 * GET  https://api.anthropic.com/api/organizations/{org}/usage?cedar_ember=1&skip_spend=1 → body.cedar_ember
 * POST .../api/organizations/{org}/reset_rate_limits
 *      { program: "cedar_ember", grant_id, request_id }
 *
 * OAuth（Claude Code）経由の /api/oauth/usage は cedar_ember を
 * `ineligible_reason: "surface"` で返すため、claude.ai の sessionKey cookie が必須。
 * 仕様は claude.ai Web バンドル（2026-09）から抽出。非公開 API のため形式変更に注意。
 */

import { randomUUID } from "node:crypto";
import {
  createCookieHeaderForUrl,
  type BrowserCookieSession,
} from "@/lib/codexbar/browser-cookies";
import { ProviderError } from "@/lib/codexbar/types";
import { asRecord, fetchText, flexibleNumber } from "@/lib/codexbar/utils";

/**
 * claude.ai は Node からのリクエストを Cloudflare チャレンジ（403）で弾く。
 * 同じ API と cookie 認証が api.anthropic.com でも通るため、そちらへ送る。
 * cookie の選択は claude.ai ドメイン基準（COOKIE_ORIGIN）。
 */
const API_ORIGIN = "https://api.anthropic.com";
const COOKIE_ORIGIN = "https://claude.ai";
const PROGRAM = "cedar_ember";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export type ClaudeResetGrant = {
  id: string;
  title: string | null;
  resetsLeft: number;
  expiresAt: string | null;
  grantedAt: string | null;
  /** "available" = 今すぐ使える（next_grant_id）、それ以外は "unavailable" / "paused"。 */
  status: "available" | "unavailable" | "paused";
};

export type ClaudeResetGrantList = {
  /** 使える順（next_grant_id が先頭）。 */
  credits: ClaudeResetGrant[];
  /** 一時停止以外の残りリセット回数合計。 */
  availableCount: number;
  nextGrantId: string | null;
  eligible: boolean;
  ineligibleReason: string | null;
  cooldownUntil: string | null;
};

export type ClaudeResetConsumeResult = {
  ok: boolean;
  code: string;
  grantId: string | null;
  resetsLeft: number | null;
};

const EMPTY: ClaudeResetGrantList = {
  credits: [],
  availableCount: 0,
  nextGrantId: null,
  eligible: false,
  ineligibleReason: null,
  cooldownUntil: null,
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** usage 応答の `cedar_ember` ブロックを解釈する（Web 版 FH と同じ可用性判定）。 */
export function parseClaudeResetGrants(block: unknown): ClaudeResetGrantList {
  const root = asRecord(block);
  if (!root || typeof root.eligible !== "boolean") return EMPTY;
  const cooldownUntil = str(root.cooldown_until);
  if (!root.eligible) {
    return { ...EMPTY, ineligibleReason: str(root.ineligible_reason), cooldownUntil };
  }
  const exhausted = root.at_limit === true ? strArray(root.exhausted) : [];
  const nextId = cooldownUntil === null ? str(root.next_grant_id) : null;
  const seen = new Set<string>();
  let nextGrantId: string | null = null;
  let availableCount = 0;
  const credits: ClaudeResetGrant[] = [];
  for (const raw of Array.isArray(root.grants) ? root.grants : []) {
    const g = asRecord(raw);
    const id = str(g?.id);
    if (!g || !id || seen.has(id)) continue;
    seen.add(id);
    const total = flexibleNumber(g.resets_total);
    const left = Math.max(
      0,
      Math.min(Math.trunc(flexibleNumber(g.resets_left) ?? 0), total ?? Infinity),
    );
    const paused = g.paused === true;
    const clears = strArray(g.clears);
    const blocking = strArray(g.blocking).filter((b) => !clears.includes(b));
    const needsLimit = g.use_requires_limit !== false;
    const usable =
      !nextGrantId &&
      id === nextId &&
      g.usable_now === true &&
      !paused &&
      blocking.length === 0 &&
      (!needsLimit || clears.some((c) => exhausted.includes(c)));
    if (usable) nextGrantId = id;
    if (!paused) availableCount += left || (usable ? 1 : 0);
    credits.push({
      id,
      title: str(g.label),
      resetsLeft: left,
      expiresAt: str(g.ends_at),
      grantedAt: str(g.starts_at),
      status: paused ? "paused" : usable ? "available" : "unavailable",
    });
  }
  credits.sort((a, b) => Number(b.id === nextGrantId) - Number(a.id === nextGrantId));
  return {
    credits,
    availableCount,
    nextGrantId,
    eligible: true,
    ineligibleReason: null,
    cooldownUntil,
  };
}

/** claude.ai 向け cookie が sessionKey を含むか。 */
export function claudeWebCookieHeader(session: BrowserCookieSession): string | null {
  const header = createCookieHeaderForUrl(session, `${COOKIE_ORIGIN}/api/organizations`);
  return header && /(?:^|; )sessionKey=/.test(header) ? header : null;
}

/** claude.ai ドメインの lastActiveOrg（Console の .claude.com 側と混同しない）。 */
export function claudeWebOrgId(session: BrowserCookieSession): string | null {
  const cookie = session.cookies.find(
    (c) =>
      c.name === "lastActiveOrg" &&
      /(^|\.)claude\.ai$/i.test(c.domain) &&
      c.value.trim().length > 0,
  );
  return cookie ? cookie.value.trim() : null;
}

function requireWebAuth(session: BrowserCookieSession): { cookie: string; orgId: string } {
  const cookie = claudeWebCookieHeader(session);
  const orgId = claudeWebOrgId(session);
  if (!cookie || !orgId) {
    throw Object.assign(
      new ProviderError(
        "Claude のリセット権には claude.ai の cookie（sessionKey・lastActiveOrg）が必要です。claude.ai にログインしたブラウザの cookie を登録してください。",
      ),
      { status: 401 },
    );
  }
  return { cookie, orgId };
}

function headers(cookie: string, json: boolean): Record<string, string> {
  return {
    Accept: "application/json",
    Cookie: cookie,
    "User-Agent": USER_AGENT,
    Origin: COOKIE_ORIGIN,
    Referer: `${COOKIE_ORIGIN}/settings/usage`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function throwIfUnauthorized(status: number, body: string): void {
  // Cloudflare のボット判定は HTML の 403 を返す。セッション切れと区別する。
  if (status === 403 && /^\s*</.test(body)) {
    throw Object.assign(
      new ProviderError("claude.ai がボット対策でリクエストを拒否しました（403）。cf_clearance を含む cookie を再登録してください。"),
      { status: 503 },
    );
  }
  if (status === 401 || status === 403) {
    throw Object.assign(
      new ProviderError("claude.ai のセッションが無効か期限切れです。cookie を再登録してください。"),
      { status },
    );
  }
}

export async function listClaudeResetGrants(
  session: BrowserCookieSession,
  signal?: AbortSignal,
): Promise<ClaudeResetGrantList> {
  const { cookie, orgId } = requireWebAuth(session);
  const url = `${API_ORIGIN}/api/organizations/${encodeURIComponent(orgId)}/usage?cedar_ember=1&skip_spend=1`;
  const { status, body, ok } = await fetchText(url, { headers: headers(cookie, false), signal });
  throwIfUnauthorized(status, body);
  if (!ok) throw new ProviderError(`Claude のリセット権の取得に失敗しました（${status}）。`);
  return parseClaudeResetGrants(asRecord(JSON.parse(body))?.cedar_ember);
}

export function parseClaudeResetConsumeJson(json: string): ClaudeResetConsumeResult {
  let root: Record<string, unknown> | null = null;
  try {
    root = asRecord(JSON.parse(json));
  } catch {
    root = null;
  }
  const code = str(root?.result) ?? "invalid_response";
  const left = flexibleNumber(root?.resets_left);
  return {
    ok: code === "reset",
    code,
    grantId: str(root?.grant_id),
    resetsLeft: left === null ? null : Math.trunc(left),
  };
}

export async function consumeClaudeResetGrant(
  session: BrowserCookieSession,
  options: { grantId: string; requestId?: string; signal?: AbortSignal },
): Promise<ClaudeResetConsumeResult> {
  const { cookie, orgId } = requireWebAuth(session);
  const { status, body, ok } = await fetchText(
    `${API_ORIGIN}/api/organizations/${encodeURIComponent(orgId)}/reset_rate_limits`,
    {
      method: "POST",
      headers: headers(cookie, true),
      body: JSON.stringify({
        program: PROGRAM,
        grant_id: options.grantId,
        request_id: options.requestId?.trim() || randomUUID(),
      }),
      signal: options.signal,
    },
  );
  throwIfUnauthorized(status, body);
  if (status === 429) return { ok: false, code: "rate_limited", grantId: null, resetsLeft: null };
  if (!ok) throw new ProviderError(`Claude のリセット権の使用に失敗しました（${status}）。`);
  return parseClaudeResetConsumeJson(body);
}

export function describeClaudeResetCode(code: string): string {
  switch (code) {
    case "reset":
      return "Claude の 5時間・週間の使用量をリセットしました。";
    case "already_used":
      return "このリセット権は既に使用済みです。";
    case "not_limited":
      return "リセット対象の使用量がありません。";
    case "cooldown":
      return "クールダウン中のため、まだ使用できません。";
    case "ineligible":
      return "このアカウントはリセット権の対象外です。";
    case "rate_limited":
      return "リクエストが多すぎます。少し待って再試行してください。";
    default:
      return `リセット権は現在使用できません（${code}）。`;
  }
}
