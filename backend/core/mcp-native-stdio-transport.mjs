import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { registerBackendChildProcess } from "./backend-child-process-registry.mjs";
import { inheritedEnvEntries } from "./mcp-native-inherited-env.mjs";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, keys) => plain(v) && keys.every((key) => Object.hasOwn(v, key));
const only = (v, keys) => Reflect.ownKeys(v).every((key) => keys.includes(key));
const unavailable = () => new Error("MCP stdio transport unavailable");
const SERVER_REQUEST_DRAIN_TIMEOUT_MS = 1_000;
const text = (v) => typeof v === "string" && !v.includes("\0");
const absolute = (v) => text(v) && isAbsolute(v);
const envKey = (key) => process.platform === "win32" ? key.toLowerCase() : key;
/**
 * A server's `cwd` chooses where its relative file IO is rooted. `..`, an absolute path or `~` must
 * not move that root out of the session directory: the session cwd is already an authority check, so
 * the child inherits the same boundary. This refuses a configured cwd that used to launch outside the
 * session (including `~/...` when the home directory is elsewhere) instead of silently trusting it.
 *
 * Both sides go through the platform's own path rules rather than string equality: the session
 * directory spelled with forward slashes, a trailing separator or `.`/`..` segments is still the same
 * directory (and, on Windows, so is a different letter case), so it must not be refused.
 *
 * The boundary is lexical: symlinks and junctions are not resolved (this factory does no IO), so it
 * stops a configured path from naming a place outside the session, not a link inside it that leads out.
 */
function resolveChildCwd(sessionCwd, configured) {
  const root = resolve(sessionCwd);
  const childCwd = resolve(root, configured);
  const inside = relative(root, childCwd);
  // "" is the session directory itself. A path on another drive comes back absolute, and a path above
  // or beside the session starts with a `..` segment (a directory merely named `..x` is inside).
  if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) throw unavailable();
  return childCwd;
}
/** `identifiers` is true for server-declared config env (must be `${NAME}`-referable and predictable);
 * the base environment only has to be a valid child env map, so ambient keys such as `ProgramFiles(x86)`
 * are kept instead of refusing every session. */
function environment(value, identifiers) {
  if (!plain(value)) throw unavailable();
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !key || key.includes("=") || key.includes("\0")
      || (identifiers && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) || result.has(envKey(key))) throw unavailable();
    const item = value[key]; if (!text(item)) throw unavailable();
    result.set(envKey(key), [key, item]);
  }
  return result;
}

/** INTERNAL inert constructor from an explicitly prepared, SDK-validated private snapshot.
 * The caller supplies the SAME binding's synchronous revision/generation assertion and must
 * reprepare this factory when any source/allowed env changes. No config reads, ambient env/home/cwd,
 * PATH discovery, command substitution, credential access or process start during construction.
 * Fixed global-source whitelist; SDK caller config/cwd/auth cannot redirect a transport.
 * This initial subset supports only absolute executables (Windows .exe/.com), tilde expansion from
 * explicit home, and ${NAME} in config env from explicit base env. Child inheritEnv is false.
 * Missing/recursive refs, other $NAME/escape syntax, !commands, PATH executables, Windows scripts/
 * shims and HTTP fail closed; broader SDK template syntax is a separate compatibility gate.
 * The explicit base environment accepts any valid env key (ambient names like `ProgramFiles(x86)`
 * are kept); server config env keys must be identifier-safe because they are referenced by name.
 * Arguments are literal, as in the SDK. Executable contents/ancestors are NOT pinned or attested;
 * cross-spawn/OS internals still have platform behavior. Not a sandbox or full process authorization.
 * Creation/start entry/completion and synchronous JSON-RPC listener dispatch are fenced.
 * Incoming server-request handlers are allowed up to one second to send their response before native
 * child cleanup; observed delivery failure still emits immediate close to release pending SDK requests.
 * Handlers that ignore cancellation may outlive this bounded drain; close observers are isolated.
 * Already delivered callbacks/started effects are not undone. Send delegates to the native SDK after
 * tracking incoming-request replies; outbound authorization remains a separate gate. No idle revocation monitoring/process drain.
 * Close/unsubscribe remain usable. Always close in finally, even after start failure.
 * Snapshot/env/options are PRIVATE, never DTOs.
 */
export function createBackendMcpStdioTransportFactory(options) {
  try {
    const keys = ["snapshot", "configPath", "sessionCwd", "homeDir", "environment", "assertSnapshotOwner"];
    if (!own(options, keys) || !only(options, keys)) throw unavailable();
    const captured = Object.fromEntries(keys.map((key) => [key, options[key]]));
    if (!absolute(captured.configPath) || basename(captured.configPath) !== "mcp.json"
      || !absolute(captured.sessionCwd) || !absolute(captured.homeDir)
      || typeof captured.assertSnapshotOwner !== "function" || types.isAsyncFunction(captured.assertSnapshotOwner)) throw unavailable();
    const all = environment(captured.environment, false), base = inheritedEnvEntries(all), snapshot = structuredClone(captured.snapshot);
    if (!own(snapshot, ["servers", "errors"]) || !only(snapshot, ["servers", "errors", "autoEnableCodemode"])
      || !Array.isArray(snapshot.servers) || !Array.isArray(snapshot.errors) || snapshot.errors.length !== 0) throw unavailable();
    const entries = new Map(), namespaces = new Set();
    for (const entry of snapshot.servers) {
      if (!own(entry, ["name", "source", "scope", "config"]) || !only(entry, ["name", "source", "scope", "config"])
        || typeof entry.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.name) || !plain(entry.config)
        || entry.source !== captured.configPath || entry.scope !== "global" || namespaces.has(entry.name.replaceAll("-", "_"))) throw unavailable();
      entries.set(entry.name, entry); namespaces.add(entry.name.replaceAll("-", "_"));
    }
    const expandHome = (value) => value === "~" ? captured.homeDir
      : value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")) ? join(captured.homeDir, value.slice(2)) : value;
    const expandEnv = (value) => {
      if (value.startsWith("!") || value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "").includes("$")) throw unavailable();
      const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_reference, key) => {
        const item = all.get(envKey(key)); if (!item || !item[1]) throw unavailable(); return item[1];
      });
      if (expanded.includes("${")) throw unavailable();
      return expanded;
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
    class OwnerStdioTransport extends StdioTransport {
      #deliveryStopped = false;
      // McpClient.handleRequest is fire-and-forget; retain peer request IDs until its response is sent.
      #incomingServerRequests = new Map();
      #requestDrainWaiters = new Set();
      #closePromise;
      #finishIncomingServerRequest(id) {
        const count = this.#incomingServerRequests.get(id) ?? 0;
        if (count <= 1) this.#incomingServerRequests.delete(id);
        else this.#incomingServerRequests.set(id, count - 1);
        if (this.#incomingServerRequests.size === 0) {
          for (const resolve of [...this.#requestDrainWaiters]) resolve(true);
        }
      }
      #waitForIncomingServerRequests() {
        if (this.#incomingServerRequests.size === 0) return Promise.resolve(true);
        return new Promise((resolve) => {
          let timer;
          const finish = (drained) => {
            if (!this.#requestDrainWaiters.delete(finish)) return;
            clearTimeout(timer);
            resolve(drained);
          };
          this.#requestDrainWaiters.add(finish);
          timer = setTimeout(() => finish(false), SERVER_REQUEST_DRAIN_TIMEOUT_MS);
          if (this.#incomingServerRequests.size === 0) finish(true);
        });
      }
      #stopDelivery() {
        if (this.#deliveryStopped) return;
        this.#deliveryStopped = true;
        try { this.emitError(unavailable()); } catch {} // A throwing observer must not block pending release/cleanup.
        // SDK onError does not reject pending requests. Close notification precedes child shutdown;
        // it does not claim the process has exited or that started effects have been cancelled.
        try { this.emitClose(); } finally { void this.close().catch(() => undefined); }
      }
      onMessage(listener) {
        return super.onMessage((message) => {
          if (this.#deliveryStopped) return;
          try { assertOwner(); } catch { this.#stopDelivery(); return; }
          const isServerRequest = message && typeof message === "object" && typeof message.method === "string"
            && Object.hasOwn(message, "id");
          if (isServerRequest) {
            const id = message.id;
            this.#incomingServerRequests.set(id, (this.#incomingServerRequests.get(id) ?? 0) + 1);
          }
          let result;
          try { result = listener(message); }
          catch (error) {
            if (isServerRequest) this.#finishIncomingServerRequest(message.id);
            try { assertOwner(); } catch { this.#stopDelivery(); }
            throw error;
          }
          try { assertOwner(); } catch { this.#stopDelivery(); }
          return result;
        });
      }
      onClose(listener) { return super.onClose(() => { try { listener(); } catch {} }); }
      async send(message) {
        await super.send(message);
        // Responses have an id and no method; outbound requests carry both.
        if (message && typeof message === "object" && !Array.isArray(message)
          && !Object.hasOwn(message, "method") && Object.hasOwn(message, "id")) {
          this.#finishIncomingServerRequest(message.id);
        }
      }
      async close() {
        this.#deliveryStopped = true;
        if (this.#closePromise) return this.#closePromise;
        this.#closePromise = (async () => {
          if (!(await this.#waitForIncomingServerRequests())) {
            try { this.emitError(new Error("MCP server request did not settle before stdio close")); } catch {}
          }
          await super.close();
        })();
        return this.#closePromise;
      }
      async start() {
        assertOwner();
        try {
          await super.start();
          assertOwner();
          const hostOwnsProcess = typeof process.send === "function";
          try { await registerBackendChildProcess(this.child); }
          catch (error) {
            if (hostOwnsProcess) {
              try { await this.close(); } catch { /* Preserve the registration failure. */ }
            }
            throw error;
          }
          assertOwner();
        } catch (error) { assertOwner(); throw error; } // Preserve native IO errors only under valid authority.
      }
    }
    return (entry, cwd, authProvider) => {
      try {
        if (checking) { fenced = true; throw unavailable(); }
        const selected = structuredClone(entry), fixed = entries.get(selected?.name);
        if (!fixed || !isDeepStrictEqual(selected, fixed) || cwd !== captured.sessionCwd || authProvider !== undefined) throw unavailable();
        const config = fixed.config;
        if (!only(config, ["command", "args", "cwd", "env", "type", "enabled", "exposure", "toolExposure", "description", "timeout"])
          || !text(config.command) || !config.command || (config.type !== undefined && config.type !== "stdio") || config.enabled === false
          || (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(text)))
          || (config.cwd !== undefined && !text(config.cwd))) throw unavailable();
        const command = expandHome(config.command);
        if (!absolute(command) || command.includes("${") || (process.platform === "win32" && !/\.(exe|com)$/i.test(command))) throw unavailable();
        const env = new Map(base);
        for (const [normalized, [key, value]] of environment(config.env ?? {}, true)) env.set(normalized, [key, expandEnv(value)]);
        const childEnv = Object.freeze(Object.fromEntries(env.values()));
        const args = (config.args ?? []).map(expandHome), childCwd = resolveChildCwd(captured.sessionCwd, expandHome(config.cwd ?? "."));
        assertOwner();
        const transport = new OwnerStdioTransport({ command, args, cwd: childCwd, env: childEnv, inheritEnv: false, stderr: "pipe" });
        Object.freeze(transport.options.args);
        Object.defineProperty(transport, "options", { value: transport.options, writable: false, configurable: false, enumerable: true });
        assertOwner(); return transport;
      } catch { throw unavailable(); }
    };
  } catch { throw unavailable(); }
}
