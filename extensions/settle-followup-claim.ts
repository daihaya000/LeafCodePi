/**
 * Cross-extension settle follow-up coordination.
 * `prepare` on agent_end; check/mark around sendMessage on agent_settled.
 * Only one gate should fire per agent_end→settled cycle.
 *
 * Multiple extensions may call prepare for the same agent_end. Coalesce those
 * into a single epoch bump for the current synchronous turn (microtask boundary).
 */
let claimEpoch = 0;
let claimedEpoch = -1;
let prepareLatched = false;

export function prepareSettleFollowUpClaim(): void {
  if (prepareLatched) return;
  prepareLatched = true;
  claimEpoch += 1;
  queueMicrotask(() => {
    prepareLatched = false;
  });
}

export function isSettleFollowUpClaimed(): boolean {
  return claimedEpoch === claimEpoch;
}

export function markSettleFollowUpClaimed(): void {
  claimedEpoch = claimEpoch;
}

/** Test-only: clear module state between Vitest cases. */
export function resetSettleFollowUpClaimForTests(): void {
  claimEpoch = 0;
  claimedEpoch = -1;
  prepareLatched = false;
}
