import { statSync } from "node:fs";
import { BUNDLE_PATH, buildBackendRuntime } from "../../scripts/build-backend-runtime.mjs";

/** A failed compile must not strand the runtime when a previous bundle is available. */
export async function buildBackendWithFallback({
  force = false,
  log = console.log,
  error = console.error,
  build = buildBackendRuntime,
  bundlePath = BUNDLE_PATH,
} = {}) {
  try {
    return await build({ force, log });
  } catch (err) {
    let hasPrevious = false;
    try { hasPrevious = statSync(bundlePath).size > 0; } catch { /* no previous build */ }
    if (!hasPrevious) throw err;
    error(`Backend rebuild failed; starting the previous build (${err instanceof Error ? err.message : String(err)})`);
    return { outfile: bundlePath, reused: true, fallback: true };
  }
}
