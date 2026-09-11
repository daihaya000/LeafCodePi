import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  DEFAULT_SYSTEM_SAFETY_LEVEL,
  parseSystemSafetyLevel,
  systemSafetyEnabled,
  systemSafetyLevelFromIndex,
  systemSafetyLevelIndex,
  SYSTEM_SAFETY_LEVELS,
} from "./system-safety";

describe("system-safety levels", () => {
  it("defaults to off and maps legacy booleans", () => {
    assert.equal(DEFAULT_SYSTEM_SAFETY_LEVEL, "off");
    assert.equal(parseSystemSafetyLevel(undefined), "off");
    assert.equal(parseSystemSafetyLevel(true), "standard");
    assert.equal(parseSystemSafetyLevel(false), "off");
    assert.equal(parseSystemSafetyLevel("low"), "low");
    assert.equal(parseSystemSafetyLevel("nope"), "off");
    assert.deepEqual([...SYSTEM_SAFETY_LEVELS], ["off", "low", "standard", "strict"]);
    assert.equal(systemSafetyEnabled("off"), false);
    assert.equal(systemSafetyEnabled("standard"), true);
    assert.equal(systemSafetyLevelIndex("standard"), 2);
    assert.equal(systemSafetyLevelFromIndex(3), "strict");
  });
});
