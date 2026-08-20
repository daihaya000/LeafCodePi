/**
 * Decide how the tray host should launch the Next.js WebUI.
 * @param {string | undefined} mode
 * @param {boolean} hasBuild
 */
export function getWebLaunchPlan(mode, hasBuild) {
  const explicitProd = mode === "prod";
  const explicitDev = mode === "dev";
  const useProd = explicitProd || (!explicitDev && hasBuild);
  return {
    needsBuild: useProd && !hasBuild,
    useProd,
  };
}

export function getPostBuildLaunchPlan(mode, hasBuild) {
  const explicitDev = mode === "dev";
  if (explicitDev) return { needsBuild: false, useProd: false };
  return { needsBuild: !hasBuild, useProd: hasBuild };
}

export function formatWebStatus({ building, running, httpUp }) {
  if (building) return "LeafCodePi: building...";
  if (running && httpUp) return "LeafCodePi: running";
  if (running) return "LeafCodePi: starting...";
  return "LeafCodePi: stopped";
}

export function procRunning(proc) {
  return proc != null && proc.exitCode == null && !proc.killed;
}
