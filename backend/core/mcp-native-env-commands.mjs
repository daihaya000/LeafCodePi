const unavailable = () => new Error("MCP env command resolution unavailable");
const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Rewrites adapter-style command-valued secrets in a PRIVATE snapshot copy.
 *
 * The legacy adapter resolved `!command` env/header values by running the command at connect time.
 * The native transports never execute configuration, so the owner resolves them once here instead:
 * `!!x` unescapes to `!x`, `!cmd` takes the trimmed stdout of the injected synchronous executor, and
 * a command that fails, times out or prints nothing keeps its original marker. That last case is
 * deliberate: the transport factory then refuses only that one server with a clear reason instead of
 * failing every server in the snapshot. The caller's snapshot is never mutated, and no value leaves
 * this module (errors omit the command and its output).
 *
 * The executor is mandatory and caller-supplied: this module does not import a shell, choose one, or
 * decide timeouts/buffers — that is the owner's policy.
 */
export function resolveMcpEnvCommands(snapshot, options = {}) {
  try {
    if (!plain(snapshot) || !plain(options) || Reflect.ownKeys(options).some((key) => key !== "run")
      || typeof options.run !== "function") throw unavailable();
    if (!Array.isArray(snapshot.servers)) throw unavailable();
    const run = options.run;
    const resolved = structuredClone(snapshot);
    for (const entry of resolved.servers) {
      if (!plain(entry) || !plain(entry.config)) throw unavailable();
      for (const field of ["env", "headers"]) {
        const values = entry.config[field];
        if (values === undefined) continue;
        if (!plain(values)) throw unavailable();
        for (const key of Reflect.ownKeys(values)) {
          const value = values[key];
          if (typeof value !== "string") throw unavailable();
          if (value.startsWith("!!")) { values[key] = value.slice(1); continue; }
          if (!value.startsWith("!")) continue;
          let replacement;
          try { replacement = run(value.slice(1)); } catch { replacement = undefined; }
          if (typeof replacement === "string" && replacement.length > 0) values[key] = replacement;
        }
      }
    }
    return resolved;
  } catch { throw unavailable(); }
}
