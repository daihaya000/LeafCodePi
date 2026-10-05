/**
 * Decide whether repeated Backend health failures mean a hung process that the Host should restart.
 * Only timeout/unreachable count: auth/protocol failures need operator action, not a kill loop.
 */
export const BACKEND_HANG_STRIKE_LIMIT = 3;

export function nextBackendHangStrikes(strikes, health) {
  if (health?.ok === true && health.ready === true) return 0;
  if (health?.reason === "timeout" || health?.reason === "unreachable") return strikes + 1;
  return 0;
}

export function backendHangShouldRestart(strikes, limit = BACKEND_HANG_STRIKE_LIMIT) {
  return strikes >= limit;
}
