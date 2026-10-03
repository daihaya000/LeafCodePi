import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { StdioTransport } from "@earendil-works/pi-mcp";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, keys) => plain(v) && keys.every((key) => Object.hasOwn(v, key));
const only = (v, keys) => Reflect.ownKeys(v).every((key) => keys.includes(key));
const unavailable = () => new Error("MCP stdio transport unavailable");
const text = (v) => typeof v === "string" && !v.includes("\0");
const absolute = (v) => text(v) && isAbsolute(v);
const envKey = (key) => process.platform === "win32" ? key.toLowerCase() : key;
/**
 * Names a stdio child inherits implicitly: what an executable, a shell or a TLS/proxy stack needs to
 * start at all. Everything else in the Backend environment (tokens for other services, session
 * material) used to reach every MCP child; a server that needs one declares it in its own `env`,
 * where `${NAME}` still expands from the full snapshot. Matching is case-insensitive on Windows and
 * exact on POSIX, because that is how the OS treats env names there.
 */
const INHERITED_ENV_NAMES = new Set([
  "path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir",
  "userprofile", "homedrive", "homepath", "appdata", "localappdata", "programdata",
  "programfiles", "programfiles(x86)", "commonprogramfiles", "commonprogramfiles(x86)",
  "number_of_processors", "processor_architecture", "processor_identifier", "os",
  "home", "lang", "language", "lc_all", "lc_ctype", "tz", "shell", "term",
  "ssl_cert_file", "ssl_cert_dir", "node_extra_ca_certs", "node_path", "node_options",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
]);
/** Config prefixes that are tooling settings rather than another service's credential. */
const INHERITED_ENV_PREFIXES = ["npm_config_", "npm_package_", "pnpm_", "yarn_", "NPM_CONFIG_", "PNPM_", "YARN_"];

function inheritedEnvironment(all) {
  const result = new Map();
  for (const [normalized, pair] of all) {
    const name = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!INHERITED_ENV_NAMES.has(name) && !INHERITED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    result.set(normalized, pair);
  }
  return result;
}
/**
 * A server's `cwd` chooses where its relative file IO is rooted. `..`, an absolute path or `~` must
 * not move that root out of the session directory: the session cwd is already an authority check, so
 * the child inherits the same boundary. This refuses a configured cwd that used to launch outside the
 * session (including `~/...` when the home directory is elsewhere) instead of silently trusting it.
 */
function resolveChildCwd(sessionCwd, configured) {
  const childCwd = resolve(sessionCwd, configured);
  if (childCwd === sessionCwd) return childCwd;
  const inside = relative(sessionCwd, childCwd);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes("..")) throw unavailable();
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
 * Async listener work is not awaited/cancelled. Observed delivery failure emits immediate close
 * to release SDK pending requests, then attempts native child cleanup; close observers are isolated.
 * Already delivered callbacks/started effects are not undone. Send is still the native SDK method;
 * outbound authorization remains a separate gate. No idle revocation monitoring/process drain.
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
    const all = environment(captured.environment, false), base = inheritedEnvironment(all), snapshot = structuredClone(captured.snapshot);
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
          try { listener(message); }
          finally { try { assertOwner(); } catch { this.#stopDelivery(); } }
        });
      }
      onClose(listener) { return super.onClose(() => { try { listener(); } catch {} }); }
      async close() { this.#deliveryStopped = true; await super.close(); }
      async start() {
        assertOwner();
        try { await super.start(); assertOwner(); }
        catch (error) { assertOwner(); throw error; } // Preserve native IO errors only under valid authority.
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
