/**
 * Cross-extension settle follow-up coordination.
 * `prepare` on agent_end; check/mark around sendMessage on agent_settled.
 * Only one gate should fire per agent_end→settled cycle.
 *
 * Pi loads each extension with a fresh jiti (`moduleCache: false`), so module
 * locals are NOT shared across extensions. State lives on `globalThis` via
 * `Symbol.for` — same pattern as leafcode-subagents registries.
 *
 * Multiple extensions may call prepare for the same agent_end. Coalesce those
 * into a single epoch bump for the current synchronous turn (microtask boundary).
 */

type SettleClaimState = {
  claimEpoch: number;
  claimedEpoch: number;
  prepareLatched: boolean;
};

const STATE_KEY = Symbol.for("leafcode.settle-followup-claim");

function settleClaimState(): SettleClaimState {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const existing = globalObject[STATE_KEY];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as SettleClaimState;
  }
  const created: SettleClaimState = {
    claimEpoch: 0,
    claimedEpoch: -1,
    prepareLatched: false,
  };
  globalObject[STATE_KEY] = created;
  return created;
}

export function prepareSettleFollowUpClaim(): void {
  const state = settleClaimState();
  if (state.prepareLatched) return;
  state.prepareLatched = true;
  state.claimEpoch += 1;
  queueMicrotask(() => {
    state.prepareLatched = false;
  });
}

export function isSettleFollowUpClaimed(): boolean {
  const state = settleClaimState();
  return state.claimedEpoch === state.claimEpoch;
}

export function markSettleFollowUpClaimed(): void {
  const state = settleClaimState();
  state.claimedEpoch = state.claimEpoch;
}

/** Test-only: clear module state between Vitest cases. */
export function resetSettleFollowUpClaimForTests(): void {
  const state = settleClaimState();
  state.claimEpoch = 0;
  state.claimedEpoch = -1;
  state.prepareLatched = false;
}
