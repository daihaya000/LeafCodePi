/**
 * Runtime generation identity, shared by the Host, the WebUI and the Backend process.
 *
 * The generation is an opaque build id for the running SDK/extension set (the Backend runtime
 * bundle). The Host pins the generation it started a Backend with, and every other process compares
 * what it expects with what the Backend reports: talking to a build we cannot identify risks writing
 * to the wrong runtime, so a missing generation only matches "no expectation".
 */

/** Trimmed generation, or "" when the value is absent or blank. */
export function normalizeExpectedGeneration(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Whether a running generation satisfies the expectation.
 * - No expectation: nothing to compare, so it matches.
 * - Expectation and no running generation: no match (unidentified build).
 * - Otherwise: exact equality.
 */
export function isBackendGenerationCompatible(expected, running) {
  const wanted = normalizeExpectedGeneration(expected);
  if (!wanted) return true;
  return typeof running === "string" && running.length > 0 && running === wanted;
}

/** The comparison as a payload both processes can report: what was pinned, what runs, whether they agree. */
export function runtimeGenerationStatus(expected, running) {
  const pinned = normalizeExpectedGeneration(expected);
  const current = typeof running === "string" && running.length > 0 ? running : null;
  return { pinned: pinned || null, running: current, matches: isBackendGenerationCompatible(pinned, current) };
}
