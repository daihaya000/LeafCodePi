import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./app-paths.mjs";

// Grant store for peer auth sharing (docs/plans/peer-auth-share.md).
// Only the SHA-256 of a peer token is persisted; the token itself is returned once at creation.
// Writers are the Web process only, so the read-modify-write below is not cross-process locked.

const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_GRANTS = 20;
const MAX_PROVIDERS = 32;
const LABEL_MAX = 100;

export function peerAuthConfigPath() {
  return join(dataDir(), "peer-auth.json");
}

export const generatePeerToken = () => randomBytes(32).toString("base64url");
export const hashPeerToken = (token) => createHash("sha256").update(token, "utf8").digest("hex");

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const publicGrant = ({ id, label, accountId, providers, createdAt }) => ({
  id, label, accountId, providers: [...providers], createdAt,
});

function validGrant(value) {
  return value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0
    && typeof value.label === "string" && value.label.length <= LABEL_MAX
    && typeof value.tokenSha256 === "string" && HASH.test(value.tokenSha256)
    && (value.accountId === null || (typeof value.accountId === "string" && ACCOUNT_ID.test(value.accountId)))
    && Array.isArray(value.providers) && value.providers.every((id) => typeof id === "string" && PROVIDER_ID.test(id))
    && typeof value.createdAt === "string";
}

/** @param {{ path?: string, now?: () => Date }} [options] */
export function createPeerGrantStore(options = {}) {
  const now = options.now ?? (() => new Date());
  const file = () => options.path ?? peerAuthConfigPath();

  const read = () => {
    try {
      const parsed = JSON.parse(readFileSync(file(), "utf8"));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.grants)) throw new Error("shape");
      // Unreadable or malformed entries are dropped: failing closed means they can never verify.
      return { version: 1, enabled: parsed.enabled === true, grants: parsed.grants.filter(validGrant) };
    } catch {
      return { version: 1, enabled: false, grants: [] };
    }
  };

  const write = (data) => {
    const path = file();
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  };

  return {
    isEnabled: () => read().enabled,
    setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw badRequest("enabled must be a boolean");
      const data = read();
      data.enabled = enabled;
      write(data);
    },
    list: () => read().grants.map(publicGrant),
    /** @returns {{ grant: object, token: string }} The token is never retrievable again. */
    create({ label, accountId = null, providers }) {
      if (typeof label !== "string" || !label.trim() || label.trim().length > LABEL_MAX) throw badRequest("label is invalid");
      if (accountId !== null && (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId))) throw badRequest("accountId is invalid");
      if (!Array.isArray(providers) || providers.length === 0 || providers.length > MAX_PROVIDERS
        || !providers.every((id) => typeof id === "string" && PROVIDER_ID.test(id))) throw badRequest("providers are invalid");
      const data = read();
      if (data.grants.length >= MAX_GRANTS) throw badRequest("too many grants");
      const token = generatePeerToken();
      const grant = {
        id: randomUUID(), label: label.trim(), tokenSha256: hashPeerToken(token), accountId,
        providers: [...new Set(providers)], createdAt: now().toISOString(),
      };
      data.grants.push(grant);
      write(data);
      return { grant: publicGrant(grant), token };
    },
    revoke(id) {
      const data = read();
      const grants = data.grants.filter((grant) => grant.id !== id);
      if (grants.length === data.grants.length) return false;
      write({ ...data, grants });
      return true;
    },
    /** Constant-time over every stored grant; returns the matching public grant only when sharing is enabled. */
    verify(token) {
      if (typeof token !== "string" || token.length === 0 || token.length > 512) return null;
      const data = read();
      const given = Buffer.from(hashPeerToken(token), "hex");
      let found = null;
      for (const grant of data.grants) {
        if (timingSafeEqual(given, Buffer.from(grant.tokenSha256, "hex"))) found = grant;
      }
      return data.enabled && found ? publicGrant(found) : null;
    },
  };
}
