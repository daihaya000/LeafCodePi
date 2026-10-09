// Wire contract for peer auth sharing (docs/plans/peer-auth-share.md).
// Strict parsers only: unknown keys are rejected on requests and dropped on responses,
// so a refresh token or any extra credential field can never cross the wire by accident.

const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PEER_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 16384
  && !/[\x00-\x1f\x7f]/.test(value);

/** `Authorization: Bearer <token>` -> token, or null when absent or malformed. */
export function parsePeerBearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match && PEER_TOKEN.test(match[1]) ? match[1] : null;
}

/** Body of POST /api/peer-auth/resolve. An omitted accountId means the default account. */
export function parsePeerResolveRequest(body) {
  if (!plain(body) || Object.keys(body).some((key) => !["providerId", "accountId"].includes(key))) return { ok: false };
  const { providerId } = body;
  const accountId = Object.hasOwn(body, "accountId") ? body.accountId : null;
  if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId)) return { ok: false };
  if (accountId !== null && (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId))) return { ok: false };
  return { ok: true, value: { providerId, accountId } };
}

/** Reduces a credential to what a peer may receive: never `refresh`, never unknown fields. */
export function publicPeerCredential(value) {
  if (!plain(value)) return null;
  if (value.type === "oauth") {
    if (!text(value.access) || typeof value.expires !== "number" || !Number.isFinite(value.expires)) return null;
    return { type: "oauth", access: value.access, expires: value.expires };
  }
  if (value.type === "api_key") {
    if (!text(value.key)) return null;
    const result = { type: "api_key", key: value.key };
    if (value.env !== undefined) {
      if (!plain(value.env) || !Object.values(value.env).every((entry) => typeof entry === "string")) return null;
      result.env = { ...value.env };
    }
    return result;
  }
  return null;
}

/** Response of POST /api/peer-auth/resolve. */
export function parsePeerResolveResponse(body) {
  if (!plain(body) || Object.keys(body).some((key) => key !== "credential")) return null;
  const credential = publicPeerCredential(body.credential);
  return credential ? { credential } : null;
}

/** Response of GET /api/peer-auth/list: metadata only, no secrets. */
export function publicPeerList(value) {
  if (!plain(value) || !Array.isArray(value.providers) || !Array.isArray(value.accounts)) return null;
  const providers = [];
  for (const entry of value.providers) {
    if (!plain(entry) || typeof entry.providerId !== "string" || !PROVIDER_ID.test(entry.providerId)
      || !["api_key", "oauth"].includes(entry.type)) return null;
    providers.push({ providerId: entry.providerId, type: entry.type });
  }
  const accounts = [];
  for (const entry of value.accounts) {
    if (!plain(entry) || typeof entry.label !== "string" || entry.label.length > 100
      || (entry.accountId !== null && (typeof entry.accountId !== "string" || !ACCOUNT_ID.test(entry.accountId)))
      || !Array.isArray(entry.providers)
      || !entry.providers.every((id) => typeof id === "string" && PROVIDER_ID.test(id))) return null;
    accounts.push({ accountId: entry.accountId, label: entry.label, providers: [...new Set(entry.providers)] });
  }
  return { providers, accounts };
}

/** Body of POST /api/peer-auth/usage. Default-account usage is intentionally not shared. */
export function parsePeerUsageRequest(body) {
  if (!plain(body) || Object.keys(body).some((key) => key !== "accountId")) return { ok: false };
  if (typeof body.accountId !== "string" || !ACCOUNT_ID.test(body.accountId)) return { ok: false };
  return { ok: true, value: { accountId: body.accountId } };
}

const nullableText = (value, max = 1000) => value === null ? null
  : typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
const nullableNumber = (value) => value === null ? null
  : typeof value === "number" && Number.isFinite(value) ? value : undefined;
const isoDate = (value) => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

/** Whitelists usage-only fields; auth, account email and unknown provider fields never cross the wire. */
export function publicPeerUsageSnapshot(value) {
  if (!plain(value) || typeof value.providerId !== "string" || !PROVIDER_ID.test(value.providerId)) return null;
  const providerName = nullableText(value.providerName);
  const plan = nullableText(value.plan);
  const sourceLabel = nullableText(value.sourceLabel);
  const creditsLabel = nullableText(value.creditsLabel);
  const creditsTitle = nullableText(value.creditsTitle);
  const creditsBalance = nullableNumber(value.creditsBalance);
  const creditsUsed = nullableNumber(value.creditsUsed);
  const creditsLimit = nullableNumber(value.creditsLimit);
  const rateLimitResetCreditsAvailable = nullableNumber(value.rateLimitResetCreditsAvailable);
  const updatedAt = isoDate(value.updatedAt);
  if (providerName === undefined || plan === undefined || sourceLabel === undefined || creditsLabel === undefined
    || creditsTitle === undefined || creditsBalance === undefined || creditsUsed === undefined || creditsLimit === undefined
    || rateLimitResetCreditsAvailable === undefined || !updatedAt || typeof value.creditsEnabled !== "boolean"
    || typeof value.isStale !== "boolean" || typeof value.windows !== "object" || !Array.isArray(value.windows)) return null;
  const windows = [];
  for (const window of value.windows) {
    if (!plain(window)) return null;
    const id = nullableText(window.id);
    const title = nullableText(window.title);
    const usedPercent = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
      ? window.usedPercent
      : undefined;
    const windowDurationMs = nullableNumber(window.windowDurationMs);
    const resetsAt = window.resetsAt === null ? null : isoDate(window.resetsAt);
    if (id === undefined || title === undefined || usedPercent === undefined || windowDurationMs === undefined
      || (window.resetsAt !== null && !resetsAt) || typeof window.countsTowardLimit !== "boolean") return null;
    windows.push({ id, title, usedPercent, resetsAt, windowDurationMs, countsTowardLimit: window.countsTowardLimit });
  }
  if (value.usageDisplayOnly !== undefined && typeof value.usageDisplayOnly !== "boolean") return null;
  return {
    providerId: value.providerId,
    providerName,
    plan,
    windows,
    creditsBalance,
    creditsLabel,
    creditsEnabled: value.creditsEnabled,
    creditsTitle,
    creditsUsed,
    creditsLimit,
    sourceLabel,
    updatedAt,
    isStale: value.isStale,
    ...(value.usageDisplayOnly === undefined ? {} : { usageDisplayOnly: value.usageDisplayOnly }),
    rateLimitResetCreditsAvailable,
  };
}

/** Response of POST /api/peer-auth/usage. */
export function publicPeerUsage(value) {
  if (!plain(value) || !Array.isArray(value.providers)) return null;
  const providers = [];
  for (const entry of value.providers) {
    if (!plain(entry) || typeof entry.providerId !== "string" || !PROVIDER_ID.test(entry.providerId)
      || (entry.snapshot !== null && !plain(entry.snapshot))) return null;
    const snapshot = entry.snapshot === null ? null : publicPeerUsageSnapshot(entry.snapshot);
    if (entry.snapshot !== null && (!snapshot || snapshot.providerId !== entry.providerId)) return null;
    providers.push({ providerId: entry.providerId, snapshot });
  }
  return { providers };
}

/** Parses the same strict, whitelisted response on the receiving LCP. */
export const parsePeerUsageResponse = publicPeerUsage;
