/** Owner-only Claude resets, independent of OAuth usage polling and browser visibility. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readPeerConfig } from "@backend-core/peer-auth-config.mjs";
import { getAccount } from "@/lib/accounts";
import { extractAnthropicConsoleSession } from "../browser-cookies";
import { anthropicResetAutoConsumeWindowMs, loadCodexBarConfig } from "../codexbar-config";
import { invalidateCachedUsage } from "../cache";
import { clearProviderCache } from "../provider-cache";
import type { UsageScope } from "../types";
import { asRecord, atomicWriteText, singleFlight, withRefreshFileLock } from "../utils";
import { claudeWebCookieHeader, claudeWebOrgId, consumeClaudeResetGrant, listClaudeResetGrants } from "./anthropic-reset";

const SUCCESS_INTERVAL_MS = 5 * 60_000;
const successfulChecks = new Map<string, number>();

function enabled(accountId: string): boolean {
  const account = getAccount(accountId);
  return Boolean(account && account.enabled !== false && account.providers.includes("anthropic") && account.anthropicResetAutoConsume !== false);
}

function isApiKeyAccount(authPath: string): boolean {
  try {
    const auth = asRecord(JSON.parse(readFileSync(authPath, "utf8").replace(/^\uFEFF/, "")));
    return asRecord(auth?.anthropic)?.type === "api_key";
  } catch { return false; }
}

type PendingReset = { grantId: string; requestId: string; orgHash: string; resetsLeft: number };

function readState(path: string): { lastSuccessAt: number; pending: PendingReset | null } {
  try {
    const value = asRecord(JSON.parse(readFileSync(path, "utf8")));
    if (!value) throw new Error("Invalid reset state");
    const raw = asRecord(value.pending);
    const pending = raw && typeof raw.grantId === "string" && typeof raw.requestId === "string" &&
      typeof raw.orgHash === "string" && typeof raw.resetsLeft === "number" && Number.isInteger(raw.resetsLeft) && raw.resetsLeft > 0
      ? raw as PendingReset : null;
    if (value.pending != null && !pending) throw new Error("Invalid pending reset");
    const timestamp = value.lastSuccessAt;
    if (timestamp !== undefined && (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0)) throw new Error("Invalid reset timestamp");
    return { lastSuccessAt: typeof timestamp === "number" ? timestamp : 0, pending };
  } catch (error) {
    if (asRecord(error)?.code === "ENOENT") return { lastSuccessAt: 0, pending: null };
    throw new Error("Claude reset state unavailable");
  }
}

/** Stable UUID for an attempted use; its journal preserves it across uncertain retries. */
function requestId(org: string, grant: string, remaining: number): string {
  const hash = createHash("sha1").update(JSON.stringify(["leafcode-claude-auto-reset", org, grant, remaining])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function checkClaudeResetCredits(scope: UsageScope, signal?: AbortSignal): Promise<boolean> {
  const accountId = scope.accountId;
  const authPath = scope.authPath;
  if (scope.kind !== "account" || !accountId || !authPath || signal?.aborted || !enabled(accountId)) return false;
  if (readPeerConfig(dirname(authPath))) return false;
  if (isApiKeyAccount(authPath)) return false;
  // Explicit account file only: never borrow another account's or Chromium's cookies.
  const session = extractAnthropicConsoleSession({ authPath });
  if (!session || !claudeWebCookieHeader(session)) return false;
  const org = claudeWebOrgId(session);
  if (!org) return false;
  const marker = `${authPath}.claude-auto-reset.json`;
  return singleFlight(`claude-auto-reset:${authPath}`, () => withRefreshFileLock(`${authPath}.claude-auto-reset`, async () => {
    if (!enabled(accountId)) return false;
    const now = Date.now();
    const state = readState(marker);
    const recent = Math.max(successfulChecks.get(authPath) ?? 0, state.lastSuccessAt);
    if (recent <= now && now - recent < SUCCESS_INTERVAL_MS) return false;
    const orgHash = createHash("sha256").update(org).digest("hex");
    const pending = state.pending?.orgHash === orgHash ? state.pending : null;
    const finish = (redeemed: boolean) => {
      const successAt = Date.now();
      successfulChecks.set(authPath, successAt);
      try { atomicWriteText(marker, JSON.stringify({ lastSuccessAt: successAt })); }
      catch { console.warn("[claude-auto-reset] could not persist the successful-check timestamp"); }
      invalidateCachedUsage();
      clearProviderCache(`account:${accountId}:anthropic`);
      console.info(redeemed ? "[claude-auto-reset] redeemed an expiring reset grant" : "[claude-auto-reset] prior grant no longer needs a retry");
      return redeemed;
    };
    const list = await listClaudeResetGrants(session, signal);
    if (!list.eligible) return false;
    // Resolve a lost POST response before considering another use or next_grant_id.
    const grant = list.credits.find((entry) => entry.id === (pending?.grantId ?? list.nextGrantId));
    if (pending && (!grant || grant.resetsLeft < pending.resetsLeft)) return finish(false);
    if (!grant?.expiresAt || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(grant.expiresAt)) return false;
    const expiry = Date.parse(grant.expiresAt);
    const checkedAt = Date.now();
    const windowMs = anthropicResetAutoConsumeWindowMs(loadCodexBarConfig());
    if (!Number.isFinite(expiry)) return false;
    if (expiry < checkedAt) {
      if (pending) atomicWriteText(marker, JSON.stringify({ lastSuccessAt: state.lastSuccessAt }));
      return false;
    }
    if (expiry - checkedAt > windowMs || list.cooldownUntil !== null || list.availableCount <= 0 || grant.id !== list.nextGrantId || grant.status !== "available") return false;
    if (!Number.isInteger(grant.resetsLeft) || grant.resetsLeft <= 0) return false;
    if (!enabled(accountId) || signal?.aborted) return false;
    const attempt = pending ?? { grantId: grant.id, requestId: requestId(org, grant.id, grant.resetsLeft), orgHash, resetsLeft: grant.resetsLeft };
    // Durable before POST: a failed/unknown response must keep the original UUID and count.
    atomicWriteText(marker, JSON.stringify({ lastSuccessAt: state.lastSuccessAt, pending: attempt }));
    const result = await consumeClaudeResetGrant(session, { grantId: attempt.grantId, requestId: attempt.requestId, signal });
    if (result.ok && (result.grantId === null || result.grantId === grant.id)) return finish(true);
    if (result.code === "already_used") return finish(false);
    if (["not_limited", "cooldown", "ineligible", "rate_limited"].includes(result.code)) {
      atomicWriteText(marker, JSON.stringify({ lastSuccessAt: state.lastSuccessAt }));
    } else {
      console.warn("[claude-auto-reset] reset outcome unconfirmed; retry on next check");
    }
    return false;
  }));
}
