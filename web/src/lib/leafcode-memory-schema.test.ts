import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAFCODE_MEMORY_SETTINGS,
  parseLeafCodeMemorySettings,
} from "./leafcode-memory-schema";

describe("parseLeafCodeMemorySettings", () => {
  it("returns defaults for missing or non-object input", () => {
    expect(parseLeafCodeMemorySettings(undefined).settings).toEqual(
      DEFAULT_LEAFCODE_MEMORY_SETTINGS,
    );
    const rejected = parseLeafCodeMemorySettings("nope");
    expect(rejected.settings).toEqual(DEFAULT_LEAFCODE_MEMORY_SETTINGS);
    expect(rejected.errors.length).toBeGreaterThan(0);
  });

  it("parses a full valid settings object", () => {
    const value = {
      memoryMode: "legacy-inject",
      memoryPolicyStyle: "full",
      memoryCharLimit: 10_000,
      userCharLimit: 8_000,
      projectCharLimit: 6_000,
      sessionSearchVariant: "anchors",
      reviewEnabled: false,
      reviewTransport: "subprocess",
      reviewRecentMessages: 100,
      nudgeInterval: 20,
      nudgeToolCalls: 99,
      correctionDetection: false,
      standingInstructionsEnabled: false,
      memoryOverflowStrategy: "fifo-evict",
      overflowGraceMs: 60_000,
      consolidationTimeoutMs: 300_000,
      autoConsolidationWarnOnFailure: false,
      flushOnCompact: true,
      flushOnShutdown: false,
      flushMinTurns: 12,
      flushRecentMessages: 200,
      failureInjectionEnabled: false,
      failureInjectionMaxAgeDays: 30,
      failureInjectionMaxEntries: 10,
    };
    const { settings, errors } = parseLeafCodeMemorySettings(value);
    expect(errors).toEqual([]);
    expect(settings).toEqual(value);
  });

  it("falls back with errors for invalid enums and booleans", () => {
    const { settings, errors } = parseLeafCodeMemorySettings({
      memoryMode: "turbo",
      memoryPolicyStyle: "compact",
      reviewEnabled: "yes",
      memoryOverflowStrategy: "shuffle",
    });
    expect(settings.memoryMode).toBe(DEFAULT_LEAFCODE_MEMORY_SETTINGS.memoryMode);
    expect(settings.memoryPolicyStyle).toBe("compact");
    expect(settings.reviewEnabled).toBe(DEFAULT_LEAFCODE_MEMORY_SETTINGS.reviewEnabled);
    expect(settings.memoryOverflowStrategy).toBe(
      DEFAULT_LEAFCODE_MEMORY_SETTINGS.memoryOverflowStrategy,
    );
    expect(errors).toHaveLength(3);
  });

  it("clamps out-of-range and non-integer numbers", () => {
    const { settings, errors } = parseLeafCodeMemorySettings({
      memoryCharLimit: 10,
      nudgeInterval: 99_999,
      overflowGraceMs: 1.5,
      failureInjectionMaxEntries: -1,
    });
    expect(settings.memoryCharLimit).toBe(DEFAULT_LEAFCODE_MEMORY_SETTINGS.memoryCharLimit);
    expect(settings.nudgeInterval).toBe(DEFAULT_LEAFCODE_MEMORY_SETTINGS.nudgeInterval);
    expect(settings.overflowGraceMs).toBe(DEFAULT_LEAFCODE_MEMORY_SETTINGS.overflowGraceMs);
    expect(settings.failureInjectionMaxEntries).toBe(
      DEFAULT_LEAFCODE_MEMORY_SETTINGS.failureInjectionMaxEntries,
    );
    expect(errors).toHaveLength(4);
  });

  it("accepts partial objects and keeps defaults for the rest", () => {
    const { settings, errors } = parseLeafCodeMemorySettings({
      nudgeInterval: 7,
    });
    expect(errors).toEqual([]);
    expect(settings.nudgeInterval).toBe(7);
    expect(settings.memoryMode).toBe(DEFAULT_LEAFCODE_MEMORY_SETTINGS.memoryMode);
  });
});