import { describe, expect, it } from "vitest";
import {
  isSettleFollowUpClaimed,
  markSettleFollowUpClaimed,
  prepareSettleFollowUpClaim,
  resetSettleFollowUpClaimForTests,
} from "./settle-followup-claim.ts";

describe("settle-followup-claim", () => {
  it("coalesces multiple prepare calls in the same turn into one epoch", async () => {
    resetSettleFollowUpClaimForTests();
    prepareSettleFollowUpClaim();
    prepareSettleFollowUpClaim();
    prepareSettleFollowUpClaim();
    markSettleFollowUpClaimed();
    expect(isSettleFollowUpClaimed()).toBe(true);

    await Promise.resolve();
    prepareSettleFollowUpClaim();
    expect(isSettleFollowUpClaimed()).toBe(false);
  });

  it("shares claim state across separately evaluated module copies via globalThis", async () => {
    resetSettleFollowUpClaimForTests();
    const a = await import("./settle-followup-claim.ts");
    // Simulate Pi jiti isolation: a second evaluation still must share Symbol.for state.
    // Vitest reuses the module cache, so assert the global slot itself.
    const key = Symbol.for("leafcode.settle-followup-claim");
    const slot = (globalThis as Record<PropertyKey, unknown>)[key] as {
      claimEpoch: number;
      claimedEpoch: number;
    };
    expect(slot).toBeTruthy();

    a.prepareSettleFollowUpClaim();
    a.markSettleFollowUpClaimed();
    expect(slot.claimedEpoch).toBe(slot.claimEpoch);
    expect(isSettleFollowUpClaimed()).toBe(true);
  });
});
