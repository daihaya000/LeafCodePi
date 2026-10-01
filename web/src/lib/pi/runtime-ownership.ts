/**
 * Who owns the Pi runtime in this process.
 *
 * Before the cutover the WebUI owns it: it creates sessions, runs tools and writes the store. After the
 * cutover the independent Backend owns it, and a WebUI that started a session anyway would be a second
 * owner writing the same files. These helpers are the single answer to "may this process start a
 * session?", and the Backend itself is never blocked by the WebUI's switch.
 *
 * The switch has an explicit value on both sides (`LEAFCODE_PI_BACKEND_OWNS_RUNTIME=1` / `=in-process`),
 * so the *absent* value is free to mean "whatever this build is": a production WebUI is a client of the
 * Backend (the shipped architecture), a development one owns the runtime (there is usually no Backend
 * running next to `next dev`).
 */

/** Values that mean the Backend owns the runtime (and that the runtime is attached, for the Backend). */
const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "attach"]);
/** Values that explicitly ask this process to own the runtime. */
const OWNER_VALUES = new Set(["0", "false", "no", "off", "in-process"]);

/** Whether this process owns the Pi runtime. An explicit switch wins; otherwise production is a client. */
export function webOwnsRuntime(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.LEAFCODE_PI_BACKEND_OWNS_RUNTIME ?? "").trim().toLowerCase();
  if (ENABLED_VALUES.has(value)) return false;
  if (OWNER_VALUES.has(value)) return true;
  return (env.NODE_ENV ?? "").trim().toLowerCase() !== "production";
}

/** Whether this process *is* the Backend runtime host: it owns sessions regardless of the WebUI switch. */
export function isBackendRuntimeHost(env: Record<string, string | undefined> = process.env): boolean {
  return ENABLED_VALUES.has((env.LEAFCODE_PI_BACKEND_RUNTIME ?? "").trim().toLowerCase());
}

/**
 * Whether a local session must be refused. True only for a WebUI that has been told the Backend owns
 * the runtime; the Backend process itself is never refused.
 */
export function localRuntimeBlocked(env: Record<string, string | undefined> = process.env): boolean {
  return !isBackendRuntimeHost(env) && !webOwnsRuntime(env);
}

/** Raised when this process is asked to start a session it does not own. */
export class RuntimeNotOwnedError extends Error {
  readonly code = "RUNTIME_NOT_OWNED";

  constructor() {
    super("このプロセスはPiランタイムを所有していません（Backendが実行を所有しています）");
    this.name = "RuntimeNotOwnedError";
  }
}

export function isRuntimeNotOwnedError(value: unknown): value is RuntimeNotOwnedError {
  return value instanceof RuntimeNotOwnedError;
}

/** Throws when this process must not start a session. Called before any side effect. */
export function assertLocalRuntimeAllowed(env: Record<string, string | undefined> = process.env): void {
  if (localRuntimeBlocked(env)) throw new RuntimeNotOwnedError();
}
