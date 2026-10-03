import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePeerBearer } from "../../shared/peer-auth-wire.mjs";

// B-side peer account config: <agentDir>/accounts/<id>/peer.json (docs/plans/peer-auth-share.md).
// Its presence marks an account whose credentials come from another LCP. It holds the peer token,
// so it is written like auth.json: 0o600, atomic replace, never logged.

const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PROVIDERS = 32;

export const peerConfigPath = (accountDir) => join(accountDir, "peer.json");

/** http(s) origin only: no credentials, path, query or fragment that could redirect the token. */
export function normalizePeerUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Returns the normalized config, or null when any field is invalid. */
export function parsePeerConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return null;
  const peerUrl = normalizePeerUrl(value.peerUrl);
  const peerAccountId = value.peerAccountId ?? null;
  if (!peerUrl || typeof value.token !== "string" || parsePeerBearer(`Bearer ${value.token}`) !== value.token) return null;
  if (peerAccountId !== null && (typeof peerAccountId !== "string" || !ACCOUNT_ID.test(peerAccountId))) return null;
  if (!Array.isArray(value.providers) || value.providers.length === 0 || value.providers.length > MAX_PROVIDERS
    || !value.providers.every((id) => typeof id === "string" && PROVIDER_ID.test(id))) return null;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return null;
  return { version: 1, peerUrl, peerAccountId, providers: [...new Set(value.providers)], token: value.token, createdAt: value.createdAt };
}

/** Missing or invalid files read as null: an account is a peer account only with a valid config. */
export function readPeerConfig(accountDir) {
  try {
    return parsePeerConfig(JSON.parse(readFileSync(peerConfigPath(accountDir), "utf8")));
  } catch {
    return null;
  }
}

export function writePeerConfig(accountDir, config, now = () => new Date()) {
  const normalized = parsePeerConfig({ ...config, version: 1, createdAt: config.createdAt ?? now().toISOString() });
  if (!normalized) throw Object.assign(new Error("peer config is invalid"), { status: 400 });
  mkdirSync(accountDir, { recursive: true });
  const path = peerConfigPath(accountDir);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return normalized;
}

export function removePeerConfig(accountDir) {
  rmSync(peerConfigPath(accountDir), { force: true });
}
