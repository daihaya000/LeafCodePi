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
});
