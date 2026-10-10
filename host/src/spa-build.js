import { buildSpaGeneration, resolveSpaMirrorRoot, rollbackSpaGeneration, selectSpaGeneration, spaSourceSnapshot } from "../../scripts/spa-build-generation.mjs";

/** Host production contract only: no Backend start/stop, no dev/preview fallback. */
export async function ensureSpaGeneration({ checkout, mirrorRoot = resolveSpaMirrorRoot(), force = false, skipStale = false, build = buildSpaGeneration, log = () => {}, ...options } = {}) {
  if (!force) {
    try {
      const selected = await selectSpaGeneration(mirrorRoot, { checkout });
      if (!selected.fallback && (skipStale || selected.sourceDigest === spaSourceSnapshot(checkout).digest)) return { ...selected, reused: true };
    } catch { /* missing/stale/invalid output must go through a validated build */ }
  }
  try { return { ...await build({ checkout, mirrorRoot, log, ...options }), reused: false }; }
  catch (error) {
    let previous;
    try { previous = await selectSpaGeneration(mirrorRoot, { checkout }); }
    catch { throw new Error("SPA production build unavailable", { cause: error }); }
    log("SPA rebuild failed; retaining a verified production generation");
    return { ...previous, reused: true, fallback: true };
  }
}

/** A failed new gateway start restores the previous complete pair, never the Backend. */
export async function startSpaWithFallback({ mirrorRoot = resolveSpaMirrorRoot(), checkout, start, log = () => {} } = {}) {
  if (typeof start !== "function") throw new Error("Gateway start callback required");
  let selected = await selectSpaGeneration(mirrorRoot, { checkout });
  const recovered = selected.fallback;
  if (recovered) selected = await rollbackSpaGeneration(mirrorRoot, { checkout, expectedCurrent: selected.pointerCurrent });
  try { return { generation: selected, process: await start(selected), fallback: recovered }; }
  catch (error) {
    let previous;
    try { previous = await rollbackSpaGeneration(mirrorRoot, { checkout, expectedCurrent: selected.id }); }
    catch { throw error; }
    log("SPA gateway start failed; restoring the previous complete generation");
    return { generation: previous, process: await start(previous), fallback: true };
  }
}
