import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  parseSystemSafetyLevel,
  systemSafetyEnabled,
  SYSTEM_SAFETY_LEVELS,
} from "./system-safety";

describe("system-safety levels", () => {
  it("parses legacy booleans and known level strings", () => {
    assert.equal(parseSystemSafetyLevel(undefined), "strict");
    assert.equal(parseSystemSafetyLevel(true), "strict");
    assert.equal(parseSystemSafetyLevel(false), "off");
    assert.equal(parseSystemSafetyLevel("low"), "low");
    assert.equal(parseSystemSafetyLevel("nope"), "strict");
    assert.deepEqual([...SYSTEM_SAFETY_LEVELS], ["off", "low", "standard", "strict"]);
    assert.equal(systemSafetyEnabled("off"), false);
    assert.equal(systemSafetyEnabled("standard"), true);
  });
});
