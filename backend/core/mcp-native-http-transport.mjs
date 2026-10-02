import { basename, isAbsolute } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, keys) => plain(v) && keys.every((key) => Object.hasOwn(v, key));
const only = (v, keys) => Reflect.ownKeys(v).every((key) => keys.includes(key));
const unavailable = () => new Error("MCP HTTP transport unavailable");
const text = (v) => typeof v === "string" && !/[\0\r\n]/.test(v);
const absolute = (v) => text(v) && isAbsolute(v);

/** INTERNAL inert constructor from SDK-validated private snapshot + SAME binding authority.
 * Explicit headers variables/fetch; no config/credential/browser/network IO or ambient env lookup.
 * Variable names that cannot appear in `${NAME}` templates are kept but unreferencable.
 * Fixed global selectors/cwd and immutable MCP endpoint. HTTPS or exact loopback HTTP only;
 * userinfo/fragments/unresolved URLs, !commands, other $NAME/escapes and redirects fail closed.
 * SDK authProvider passes through unchanged: token refresh, OAuth discovery/issuer permissions,
 * pending cancellation and global-fetch use INTERNAL to that provider remain separate gates.
 * The owner fetch MUST enforce its own destination policy (OAuth context.fetch can name an issuer).
 * Start/send/fetch entry/completion are fenced, including retries/GET opens through this fetch.
 * JSON/POST SSE/GET SSE synchronous message dispatch checks authority before/after each listener.
 * Async listener work is not awaited/cancelled (SDK void-listener contract). Observed
 * failure stops delivery, emits an immediate close to release pending SDK requests, then attempts
 * cleanup. Throwing close listeners are isolated; unsubscribe remains usable. Previously delivered
 * messages/callback effects and response/SSE body consumption are NOT rolled back or fully cancelled.
 * Close remains callable; only a close-origin DELETE to the fixed endpoint bypasses authority,
 * best-effort as in the SDK. This is not SSRF/DNS pinning, writer quiescence or production activation.
 * Snapshot/headers/URL/options/auth are PRIVATE, never DTOs. Reprepare after source/variable changes.
 */
export function createBackendMcpHttpTransportFactory(options) {
  try {
    const keys = ["snapshot", "configPath", "sessionCwd", "variables", "fetch", "assertSnapshotOwner"];
    if (!own(options, keys) || !only(options, keys)) throw unavailable();
    const captured = Object.fromEntries(keys.map((key) => [key, options[key]]));
    if (!absolute(captured.configPath) || basename(captured.configPath) !== "mcp.json" || !absolute(captured.sessionCwd)
      || typeof captured.fetch !== "function" || typeof captured.assertSnapshotOwner !== "function"
      || types.isAsyncFunction(captured.assertSnapshotOwner) || !plain(captured.variables)) throw unavailable();
    const variables = new Map();
    for (const key of Reflect.ownKeys(captured.variables)) {
      // Only identifier names can be referenced, but an ambient map (process.env) may hold other keys:
      // they are unreferencable rather than a reason to refuse every endpoint.
      if (typeof key !== "string" || !key || key.includes("\0")) throw unavailable();
      const value = captured.variables[key]; if (!text(value)) throw unavailable(); variables.set(key, value);
    }
    const snapshot = structuredClone(captured.snapshot);
    if (!own(snapshot, ["servers", "errors"]) || !only(snapshot, ["servers", "errors", "autoEnableCodemode"])
      || !Array.isArray(snapshot.servers) || !Array.isArray(snapshot.errors) || snapshot.errors.length !== 0) throw unavailable();
    const entries = new Map(), namespaces = new Set();
    for (const entry of snapshot.servers) {
      if (!own(entry, ["name", "source", "scope", "config"]) || !only(entry, ["name", "source", "scope", "config"])
        || typeof entry.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.name) || !plain(entry.config)
        || entry.source !== captured.configPath || entry.scope !== "global" || namespaces.has(entry.name.replaceAll("-", "_"))) throw unavailable();
      entries.set(entry.name, entry); namespaces.add(entry.name.replaceAll("-", "_"));
    }
    const expand = (value) => {
      if (!text(value) || value.startsWith("!") || value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "").includes("$")) throw unavailable();
      const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_reference, key) => {
        const item = variables.get(key); if (!item) throw unavailable(); return item;
      });
      if (result.includes("${")) throw unavailable(); return result;
    };
    let fenced = false, checking = false;
    const assertOwner = () => {
      if (fenced || checking) { fenced = true; throw unavailable(); }
      checking = true;
      try {
        const ack = captured.assertSnapshotOwner();
        if (ack && typeof ack.then === "function") { Promise.resolve(ack).catch(() => undefined); throw unavailable(); }
        if (ack !== undefined || fenced) throw unavailable();
      } catch { fenced = true; throw unavailable(); }
      finally { checking = false; }
    };
    return (entry, cwd, authProvider) => {
      try {
        if (checking) { fenced = true; throw unavailable(); }
        const selected = structuredClone(entry), fixed = entries.get(selected?.name);
        if (!fixed || !isDeepStrictEqual(selected, fixed) || cwd !== captured.sessionCwd) throw unavailable();
        const config = fixed.config;
        if (!only(config, ["url", "headers", "oauth", "auth", "type", "enabled", "exposure", "toolExposure", "description", "timeout"])
          || !text(config.url) || config.url.startsWith("!") || config.url.includes("${") || config.enabled === false
          || (config.type !== undefined && !["http", "streamable-http"].includes(config.type))
          || (authProvider !== undefined && (!authProvider || typeof authProvider.token !== "function"
            || (authProvider.onUnauthorized !== undefined && typeof authProvider.onUnauthorized !== "function")))) throw unavailable();
        const url = new URL(config.url);
        if (url.username || url.password || config.url.includes("#") || !(url.protocol === "https:"
          || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw unavailable();
        const href = url.href, headers = {}, names = new Set();
        if (!plain(config.headers ?? {})) throw unavailable();
        for (const name of Reflect.ownKeys(config.headers ?? {})) {
          if (typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || names.has(name.toLowerCase())) throw unavailable();
          Object.defineProperty(headers, name, { value: expand(config.headers[name]), enumerable: true }); names.add(name.toLowerCase());
        }
        new Headers(headers); Object.freeze(headers); // Validate without network IO; never silently omit an invalid header.
        let closing = 0, deliveryStopped = false;
        const fetch = async (input, init) => {
          const cleanup = closing && init?.method === "DELETE" && String(input) === href;
          if (!cleanup) assertOwner();
          let response;
          try {
            response = await Reflect.apply(captured.fetch, undefined, [input, { ...init, redirect: "error" }]);
            if (!cleanup) assertOwner(); return response;
          } catch (error) {
            try { response?.body?.cancel().catch(() => undefined); } catch {}
            if (!cleanup) assertOwner(); throw error;
          }
        };
        class OwnerHttpTransport extends StreamableHttpTransport {
          #stopDelivery() {
            if (deliveryStopped) return;
            deliveryStopped = true;
            try { this.emitError(unavailable()); } catch {} // Cleanup must survive a throwing error observer.
            // SDK onError alone does not reject pending requests. Notify close immediately, even
            // if auth/DELETE cleanup subsequently awaits or fails. This is not completed/drained IO.
            try { this.emitClose(); } finally { void this.close().catch(() => undefined); }
          }
          onMessage(listener) {
            return super.onMessage((message) => {
              if (deliveryStopped) return;
              try { assertOwner(); } catch { this.#stopDelivery(); return; }
              try { listener(message); }
              finally { try { assertOwner(); } catch { this.#stopDelivery(); } }
            });
          }
          onClose(listener) { return super.onClose(() => { try { listener(); } catch {} }); }
          async start() { assertOwner(); try { await super.start(); assertOwner(); } catch (error) { assertOwner(); throw error; } }
          async send(message) { assertOwner(); try { await super.send(message); assertOwner(); } catch (error) { assertOwner(); throw error; } }
          async close() { deliveryStopped = true; closing++; try { await super.close(); } finally { closing--; } }
        }
        assertOwner();
        const transport = new OwnerHttpTransport({ url: href, headers, authProvider, fetch });
        Object.freeze(transport.options.headers);
        Object.defineProperty(transport, "options", { value: transport.options, writable: false, configurable: false, enumerable: true });
        Object.defineProperty(transport, "url", { get: () => new URL(href), configurable: false, enumerable: true });
        assertOwner(); return transport;
      } catch { throw unavailable(); }
    };
  } catch { throw unavailable(); }
}
