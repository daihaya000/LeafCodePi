/**
 * Who owns the Pi runtime in this process.
 *
 * The shipped WebUI is a client: the independent Backend owns the runtime (it creates sessions, runs
 * tools and writes the store), and a WebUI that started a session anyway would be a second owner
 * writing the same files. These helpers are the single answer to "may this process start a session?",
 * and the Backend itself is never blocked by the WebUI's rule.
 *
 * Next registers its process role before serving requests, in development and production. That
 * role is never an owner, even if a Backend marker was inherited. Standalone test/SDK consumers
 * without the Next role keep their existing ownership behavior until their own entrypoint decides it.
 */

import { assertAutoUpdateAvailable } from "./auto-update-maintenance";

const runtimeGlobals = globalThis as typeof globalThis & { __leafcodeRuntimeOwnerUnavailable?: boolean };

/** Values that mean this process is the Backend runtime host (the Backend's own marker). */
const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "attach"]);

/** Next never owns runtime; unmarked development/test consumers retain compatibility. */
export function webOwnsRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.LEAFCODE_PI_PROCESS_ROLE !== "next"
    && (env.NODE_ENV ?? "").trim().toLowerCase() !== "production";
}

/** Whether this process *is* the Backend runtime host: it owns sessions regardless of the WebUI switch. */
export function isBackendRuntimeHost(env: Record<string, string | undefined> = process.env): boolean {
  return env.LEAFCODE_PI_PROCESS_ROLE !== "next"
    && ENABLED_VALUES.has((env.LEAFCODE_PI_BACKEND_RUNTIME ?? "").trim().toLowerCase());
}

/**
 * Whether a local session must be refused. Explicit Next role takes precedence over NODE_ENV and
 * inherited Backend markers; the actual Backend process remains allowed.
 */
export function localRuntimeBlocked(env: Record<string, string | undefined> = process.env): boolean {
  return !isBackendRuntimeHost(env) && (!webOwnsRuntime(env) || runtimeGlobals.__leafcodeRuntimeOwnerUnavailable === true);
}

/** Prevents an unmarked development consumer from running after its owner slot is unavailable. */
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
  assertAutoUpdateAvailable();
  if (localRuntimeBlocked(env)) throw new RuntimeNotOwnedError();
}
