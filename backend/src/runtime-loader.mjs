import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The bundle the build script produces; it is a build artifact, not source. */
export const DEFAULT_RUNTIME_BUNDLE = resolve(HERE, "..", "runtime", "runtime.bundle.mjs");

/**
 * The runtime entry points the Backend calls. A bundle that does not export all of them was built
 * from an older entry, so it is refused instead of failing later mid-turn.
 */
export const REQUIRED_RUNTIME_EXPORTS = Object.freeze([
  "promptTask",
  "getTaskDetail",
  "abortTask",
  "listPendingAttention",
  "pendingPermissionForTask",
  "pendingQuestionForTask",
  "respondToPermissionPrompt",
  "respondToQuestionPrompt",
  "clearPendingAttentionForTask",
  "startBotCodeRelay",
  "applyCodePermissionSettingsToLiveTasks",
]);

/**
 * Loads the bundled Pi runtime for this process.
 *
 * A missing bundle, a bundle built from an older entry and a bundle that cannot be imported are all
 * reported as "not available" rather than thrown: the Backend must still start, serve transport and
 * say it is not ready. The failure reason never carries exception text, because an import error can
 * contain file paths or provider credentials.
 *
 * The generation identifies the SDK/extension set a running session is using: it is derived from
 * the bundle bytes, so a WebUI update that rebuilds the bundle is a different generation. The host
 * pins it and refuses to swap it under a running session.
 *
 * Returns `{ ok: true, runtime, generation }`, or `{ ok: false, reason, missing? }` with
 * reason ∈ "missing" | "incomplete" | "unavailable".
 */
export async function loadBackendRuntime({
  bundlePath = DEFAULT_RUNTIME_BUNDLE,
  importModule = (path) => import(pathToFileURL(path).href),
  exists = existsSync,
  readBytes = (path) => readFileSync(path),
} = {}) {
  if (!exists(bundlePath)) return { ok: false, reason: "missing" };
  let runtime;
  try {
    runtime = await importModule(bundlePath);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const missing = REQUIRED_RUNTIME_EXPORTS.filter((name) => typeof runtime?.[name] !== "function");
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing };
  // A hash that cannot be read is not fatal: the runtime works, only the generation is unknown.
  let generation = null;
  try {
    generation = createHash("sha256").update(readBytes(bundlePath)).digest("hex").slice(0, 16);
  } catch { /* generation stays null */ }
  return { ok: true, runtime, generation };
}
