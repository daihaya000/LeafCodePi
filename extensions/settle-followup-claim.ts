/**
 * Cross-extension settle follow-up coordination.
 * `prepare` on agent_end; check/mark around sendMessage on agent_settled.
 * Only one gate should fire per agent_end→settled cycle.
 */
let claimEpoch = 0;
let claimedEpoch = -1;

export function prepareSettleFollowUpClaim(): void {
  claimEpoch += 1;
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
}
