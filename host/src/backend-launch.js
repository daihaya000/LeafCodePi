import { createHash } from "node:crypto";
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync, statSync as defaultStatSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";

/**
 * What the Host needs to start the independent Backend, and nothing more.
 *
 * This is the Host/build half of the separation: the Host owns the lifecycle and pins the SDK
 * generation (the built runtime bundle) so a WebUI update cannot swap the dependencies a running
 * session uses. The plan is pure data — spawning stays in the Host — so it can be tested without a
 * live process.
 *
 * The runtime bundle is a build artifact. When it is missing the plan still returns, with
 * `generation: null` and `runtime: "detached"`: a Backend without a bundle must start, serve
 * transport and report itself as not ready rather than fail the Host.
 */

/** The switch values that make the Backend attach the runtime. */
const RUNTIME_ENABLED_VALUES = new Set(["1", "true", "yes", "attach"]);

/** Where the build script writes the runtime bundle, relative to the repo root. */
export const RUNTIME_BUNDLE_RELATIVE_PATH = join("backend", "runtime", "runtime.bundle.mjs");

/** The Backend's own entry point, relative to the repo root. */
export const BACKEND_ENTRY_RELATIVE_PATH = join("backend", "src", "entry.mjs");

/**
 * A stable id for the bundle contents: a rebuild is a different generation, so the Host can tell
 * whether the Backend it is talking to is the build it started. Null when the bundle is unreadable.
 */
export function bundleGeneration(
  bundlePath,
  { exists = defaultExistsSync, readBytes = defaultReadFileSync, stat = defaultStatSync } = {},
) {
  if (!exists(bundlePath)) return null;
  try {
    // The bundle is ~6 MB and planBackend runs on every start/re-plan, so a hash is reused while the
    // file is byte-for-byte the same as far as mtime and size can tell. Injected readers always hash.
    let key = null;
    if (readBytes === defaultReadFileSync) {
      try {
        const stats = stat(bundlePath, { bigint: true });
        key = `${stats.mtimeNs}:${stats.size}`;
      } catch { /* no stat: hash without caching */ }
      const cached = key === null ? undefined : generationCache.get(bundlePath);
      if (cached && cached.key === key) return cached.generation;
    }
    const generation = createHash("sha256").update(readBytes(bundlePath)).digest("hex").slice(0, 16);
    if (key !== null) generationCache.set(bundlePath, { key, generation });
    return generation;
  } catch {
    return null;
  }
}

/** bundle path -> the hash computed for one mtime+size. */
const generationCache = new Map();

/**
 * The environment for a Backend child of this Host.
 *
 * `token` is required: the internal API is bearer-authenticated, and a Backend without a token
 * refuses to start. The same token and generation are handed to the WebUI child so it can talk to
 * the Backend and detect a generation mismatch.
 */
export function backendLaunchPlan({
  repoRoot,
  env = {},
  token,
  attachRuntime = false,
  bundlePath,
  generation,
} = {}) {
  if (!repoRoot) throw new Error("repoRoot is required");
  if (!token) throw new Error("token is required");
  const bundle = bundlePath ?? join(repoRoot, RUNTIME_BUNDLE_RELATIVE_PATH);
  // An explicit `generation: null` means "do not pin", so only an absent value is derived.
  const pinned = generation === undefined ? bundleGeneration(bundle) : generation;
  const runtime = attachRuntime || RUNTIME_ENABLED_VALUES.has((env.LEAFCODE_PI_BACKEND_RUNTIME ?? "").trim().toLowerCase());
  const port = env.LEAFCODE_PI_BACKEND_PORT?.trim();
  return {
    command: process.execPath,
    args: [join(repoRoot, BACKEND_ENTRY_RELATIVE_PATH)],
    cwd: repoRoot,
    generation: pinned ?? null,
    runtime: runtime ? "attach" : "detached",
    env: {
      LEAFCODE_PI_BACKEND_TOKEN: token,
      // Attach only when the Host is ready to hand the runtime over: two owners would double-write
      // the store, leases and sessions.
      LEAFCODE_PI_BACKEND_RUNTIME: runtime ? "attach" : "",
      LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: bundle,
      // Native MCP is the default for this Backend generation: the runtime bundle owns the session MCP
      // factories and the bundled adapter is not loaded. Set `LEAFCODE_PI_MCP_NATIVE=0` in the Host
      // environment to roll back to the adapter without a code change.
      LEAFCODE_PI_MCP_NATIVE: env.LEAFCODE_PI_MCP_NATIVE ?? "1",
      ...(port ? { LEAFCODE_PI_BACKEND_PORT: port } : {}),
      // A Backend started without a generation has nothing to compare, so the Host pins only what
      // it can identify.
      ...(pinned ? { LEAFCODE_PI_BACKEND_GENERATION: pinned } : {}),
    },
  };
}

/** The Backend-facing values the WebUI child needs: how to reach it, and which generation to expect. */
export function backendClientEnv(plan) {
  if (!plan) throw new Error("plan is required");
  // Always resolve a URL: consumers that treat a missing value as "cannot verify" (the runtime
  // restart guard) would otherwise refuse every operation while the Backend runs on its default port.
  const port = plan.env.LEAFCODE_PI_BACKEND_PORT?.trim() || String(DEFAULT_BACKEND_PORT);
  return {
    LEAFCODE_PI_BACKEND_TOKEN: plan.env.LEAFCODE_PI_BACKEND_TOKEN,
    LEAFCODE_PI_BACKEND_URL: `http://127.0.0.1:${port}`,
    ...(plan.generation ? { LEAFCODE_PI_BACKEND_GENERATION: plan.generation } : {}),
  };
}
