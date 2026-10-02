import { createBackendMcpCredentials } from "./mcp-native-credentials.mjs";
import { publicMcpAuthSnapshot } from "../../shared/mcp-auth-snapshot.mjs";

const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const unavailable = () => new Error("MCP OAuth status unavailable");
function synchronous(value) {
  if (value && typeof value.then === "function") {
    Promise.resolve(value).catch(() => undefined);
    throw unavailable();
  }
  return value;
}

/**
 * INTERNAL read-only OAuth metadata, not generic auth-type inference or a route.
 * The caller selects an OAuth-eligible configured endpoint; the explicit owner
 * must attest that exact canonical namespace+URL on every call. No default store.
 * Construction performs no IO. Never calls writeState/removeState/withRefreshLock;
 * injected readState may use temporary document locks. No refresh/browser/network,
 * legacy URL-only lookup, fallback, credential mutation, pending-flow inference or cache.
 * SDK tokensExpireAt is absolute MILLISECONDS, not the adapter's expiresAt seconds.
 * Missing anchors for expires_in and malformed expiry return unknown, not valid.
 * Present means locally stored, not server acceptance or guaranteed usability.
 * Only the existing public whitelist leaves this boundary; errors omit causes/data.
 */
export function createBackendMcpOAuthStatusReader(options) {
  try {
    if (!plain(options) || !Object.hasOwn(options, "owner")
      || Object.keys(options).some((key) => !["owner", "now"].includes(key))) throw unavailable();
    const owner = options.owner;
    const suppliedNow = Object.hasOwn(options, "now") ? options.now : undefined;
    const now = suppliedNow === undefined ? Date.now : suppliedNow;
    if (typeof now !== "function") throw unavailable();
    const credentials = createBackendMcpCredentials(owner);
    return (name, serverUrl) => {
      try {
        const state = credentials.forServer(name, serverUrl).load();
        const time = synchronous(now());
        if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > Number.MAX_SAFE_INTEGER) throw unavailable();
        const configured = !!state && Object.hasOwn(state, "tokens") && state.tokens !== undefined;
        let status = "missing";
        if (configured) {
          const expiry = Object.hasOwn(state, "tokensExpireAt") ? state.tokensExpireAt : undefined;
          if (expiry === undefined) {
            status = Object.hasOwn(state.tokens, "expires_in") && state.tokens.expires_in !== undefined ? "unknown" : "present";
          } else if (typeof expiry !== "number" || !Number.isFinite(expiry) || Math.abs(expiry) > Number.MAX_SAFE_INTEGER) {
            status = "unknown";
          } else status = expiry <= time ? "expired" : "present";
        }
        const snapshot = publicMcpAuthSnapshot({ name, url: serverUrl, authType: "oauth", credentialSource: "oauth",
          credentialConfigured: configured, credentialStatus: status });
        if (!snapshot) throw unavailable();
        // Re-attest after private reads/clock callbacks, without a second state read.
        credentials.forServer(name, serverUrl);
        return snapshot;
      } catch { throw unavailable(); }
    };
  } catch { throw unavailable(); }
}
