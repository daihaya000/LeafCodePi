import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./app-paths.mjs";
import { withDirectoryLock } from "./directory-lock.mjs";

// Grant store for peer auth sharing (docs/plans/peer-auth-share.md).
// Only the SHA-256 of a peer token is persisted; the token itself is returned once at creation.
// Read-modify-write sequences run under a lock directory so concurrent web workers cannot lose grants,
// and they refuse to overwrite a store file that exists but cannot be parsed (verify still fails closed).
const LOCK_STALE_MS = 30_000;

const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;
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

const publicGrant = ({ id, label, providers, createdAt }) => ({
  id, label, providers: [...providers], createdAt,
});

function validGrant(value) {
  return value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0
    && typeof value.label === "string" && value.label.length <= LABEL_MAX
    && typeof value.tokenSha256 === "string" && HASH.test(value.tokenSha256)
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

  /** Like read(), but a present-yet-unreadable store aborts the update instead of being replaced by an empty one. */
  const readForUpdate = () => {
    let text;
    try {
      text = readFileSync(file(), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return read();
      throw Object.assign(new Error("peer auth store is unreadable"), { status: 500 });
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.grants)) throw new Error("shape");
    } catch {
      throw Object.assign(new Error("peer auth store is corrupted; fix or remove peer-auth.json"), { status: 500 });
    }
    return read();
  };

  const locked = (action) => {
    const path = file();
    return withDirectoryLock({
      lockPath: `${path}.lock`, parentDir: dirname(path), staleMs: LOCK_STALE_MS, busyMessage: "peer auth store is busy",
    }, action);
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
      locked(() => {
        const data = readForUpdate();
        data.enabled = enabled;
        write(data);
      });
    },
    list: () => read().grants.map(publicGrant),
    /** @returns {{ grant: object, token: string }} The token is never retrievable again. */
    create({ label, providers }) {
      if (typeof label !== "string" || !label.trim() || label.trim().length > LABEL_MAX) throw badRequest("label is invalid");
      if (!Array.isArray(providers) || providers.length === 0 || providers.length > MAX_PROVIDERS
        || !providers.every((id) => typeof id === "string" && PROVIDER_ID.test(id))) throw badRequest("providers are invalid");
      return locked(() => {
        const data = readForUpdate();
        if (data.grants.length >= MAX_GRANTS) throw badRequest("too many grants");
        const token = generatePeerToken();
        const grant = {
          id: randomUUID(), label: label.trim(), tokenSha256: hashPeerToken(token),
          providers: [...new Set(providers)], createdAt: now().toISOString(),
        };
        data.grants.push(grant);
        write(data);
        return { grant: publicGrant(grant), token };
      });
    },
    revoke(id) {
      return locked(() => {
        const data = readForUpdate();
        const grants = data.grants.filter((grant) => grant.id !== id);
        if (grants.length === data.grants.length) return false;
        write({ ...data, grants });
        return true;
      });
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
