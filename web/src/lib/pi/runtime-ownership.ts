/**
 * Who owns the Pi runtime in this process.
 *
 * The shipped WebUI is a client: the independent Backend owns the runtime (it creates sessions, runs
 * tools and writes the store), and a WebUI that started a session anyway would be a second owner
 * writing the same files. These helpers are the single answer to "may this process start a session?",
 * and the Backend itself is never blocked by the WebUI's rule.
 *
 * There is no ownership switch left: a production WebUI is a client, and a development one owns the
 * runtime because `next dev` usually runs without a Backend next to it. The Host always starts the
 * Backend and the WebUI as its client, so production never needs to be told.
 */

const runtimeGlobals = globalThis as typeof globalThis & { __leafcodeRuntimeOwnerUnavailable?: boolean };

/** Values that mean this process is the Backend runtime host (the Backend's own marker). */
const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "attach"]);

/** Whether this process owns the Pi runtime: only a development build does. */
export function webOwnsRuntime(env: Record<string, string | undefined> = process.env): boolean {
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
  return !isBackendRuntimeHost(env) && (!webOwnsRuntime(env) || runtimeGlobals.__leafcodeRuntimeOwnerUnavailable === true);
}

/** Prevents a dev Web process from starting sessions after another process owns the shared data dir. */
export function setRuntimeOwnerUnavailable(unavailable: boolean): void {
  runtimeGlobals.__leafcodeRuntimeOwnerUnavailable = unavailable;
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
