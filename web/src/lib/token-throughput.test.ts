import { describe, expect, it } from "vitest";
import {
  createThroughputTiming,
  decodeTokensPerSecond,
  endToEndTokensPerSecond,
  estimateTokensFromChars,
  formatTokensPerSecond,
  noteContentDelta,
  noteReportedOutputTokens,
  snapshotThroughput,
  timingFromPersisted,
  toPersistedThroughput,
} from "./token-throughput";

describe("decodeTokensPerSecond", () => {
  it("uses (N-1)/(T_last-T_first) for the decode window", () => {
    // 101 tokens over 1.0s → 100 inter-token intervals → 100 tok/s
    expect(decodeTokensPerSecond(101, 1_000, 2_000)).toBe(100);
  });

  it("needs at least two tokens", () => {
    expect(decodeTokensPerSecond(1, 1_000, 2_000)).toBeNull();
    expect(decodeTokensPerSecond(0, 1_000, 2_000)).toBeNull();
  });

  it("rejects non-positive decode windows", () => {
    expect(decodeTokensPerSecond(10, 2_000, 1_000)).toBeNull();
    expect(decodeTokensPerSecond(10, 1_000, 1_000)).toBeNull();
  });
});

describe("endToEndTokensPerSecond", () => {
  it("divides all output tokens by wall time including TTFT", () => {
    expect(endToEndTokensPerSecond(100, 0, 2_000)).toBe(50);
  });
});

describe("snapshotThroughput", () => {
  it("prefers decode tok/s when first/last token times exist", () => {
    let timing = createThroughputTiming(0);
    timing = noteContentDelta(timing, "hello", 500);
    timing = noteContentDelta(timing, " world", 1_500);
    timing = noteReportedOutputTokens(timing, 101);
    const snap = snapshotThroughput(timing, 1_500);
    expect(snap).toEqual({
      outputTokens: 101,
      tokensPerSecond: 100,
      decodePhase: true,
    });
  });

  it("falls back to end-to-end when first token was never observed", () => {
    let timing = createThroughputTiming(0);
    timing = noteReportedOutputTokens(timing, 50);
    timing = { ...timing, lastTokenAtMs: 2_000 };
    const snap = snapshotThroughput(timing);
    expect(snap).toEqual({
      outputTokens: 50,
      tokensPerSecond: 25,
      decodePhase: false,
    });
  });

  it("estimates tokens from streamed chars while usage is pending", () => {
    let timing = createThroughputTiming(0);
    timing = noteContentDelta(timing, "a".repeat(40), 100);
    timing = noteContentDelta(timing, "b".repeat(40), 1_100);
    const snap = snapshotThroughput(timing, 1_100);
    expect(estimateTokensFromChars(80)).toBe(20);
    expect(snap?.outputTokens).toBe(20);
    expect(snap?.decodePhase).toBe(true);
    expect(snap?.tokensPerSecond).toBeCloseTo(19, 5);
  });
});

describe("formatTokensPerSecond", () => {
  it("formats compact labels", () => {
    expect(formatTokensPerSecond(4.2)).toBe("4.2 tok/s");
    expect(formatTokensPerSecond(42.4)).toBe("42 tok/s");
    expect(formatTokensPerSecond(1_250)).toBe("1.3k tok/s");
  });
});

describe("persistence", () => {
  it("round-trips finalized timings", () => {
    let timing = createThroughputTiming(1_000);
    timing = noteContentDelta(timing, "abcd", 1_200);
    timing = noteContentDelta(timing, "efgh", 2_200);
    timing = noteReportedOutputTokens(timing, 101);
    const persisted = toPersistedThroughput(timing);
    expect(persisted).toEqual({
      startedAtMs: 1_000,
      firstTokenAtMs: 1_200,
      lastTokenAtMs: 2_200,
      outputTokens: 101,
    });
    const restored = timingFromPersisted(persisted);
    expect(restored).toMatchObject(persisted!);
    expect(snapshotThroughput(restored!)?.tokensPerSecond).toBe(100);
  });

  it("skips incomplete timings", () => {
    expect(toPersistedThroughput(createThroughputTiming(1))).toBeNull();
    expect(timingFromPersisted({ startedAtMs: "x" })).toBeNull();
  });
});
