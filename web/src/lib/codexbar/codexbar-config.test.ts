import { describe, expect, it } from "vitest";
import {
  codexResetAutoConsumeWindowMs,
  DEFAULT_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS,
  MAX_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS,
} from "./codexbar-config";

describe("codexResetAutoConsumeWindowMs", () => {
  it("fails closed unless auto-redeem is explicitly enabled", () => {
    expect(codexResetAutoConsumeWindowMs({})).toBeNull();
    expect(
      codexResetAutoConsumeWindowMs({ codexResetAutoConsume: false }),
    ).toBeNull();
  });

  it("uses the safe default window after explicit opt-in", () => {
    expect(
      codexResetAutoConsumeWindowMs({ codexResetAutoConsume: true }),
    ).toBe(DEFAULT_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS * 60 * 60 * 1000);
  });

  it("accepts a bounded positive custom window", () => {
    expect(
      codexResetAutoConsumeWindowMs({
        codexResetAutoConsume: true,
        codexResetAutoConsumeWindowHours: 12,
      }),
    ).toBe(12 * 60 * 60 * 1000);
  });

  it("rejects invalid and overly broad windows", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        codexResetAutoConsumeWindowMs({
          codexResetAutoConsume: true,
          codexResetAutoConsumeWindowHours: value,
        }),
      ).toBeNull();
    }
    expect(
      codexResetAutoConsumeWindowMs({
        codexResetAutoConsume: true,
        codexResetAutoConsumeWindowHours:
          MAX_CODEX_RESET_AUTO_CONSUME_WINDOW_HOURS + 1,
      }),
    ).toBeNull();
  });
});
