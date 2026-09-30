import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isBackendGenerationCompatible,
  normalizeExpectedGeneration,
  runtimeGenerationStatus,
} from "./backend-generation.mjs";

test("an expectation is trimmed, and a blank one means no expectation", () => {
  assert.equal(normalizeExpectedGeneration(" gen-a "), "gen-a");
  assert.equal(normalizeExpectedGeneration("   "), "");
  assert.equal(normalizeExpectedGeneration(undefined), "");
  assert.equal(normalizeExpectedGeneration(null), "");
  assert.equal(normalizeExpectedGeneration(42), "");
});

test("no expectation matches anything, including an unidentified Backend", () => {
  assert.equal(isBackendGenerationCompatible("", "gen-b"), true);
  assert.equal(isBackendGenerationCompatible("", null), true);
  assert.equal(isBackendGenerationCompatible("", undefined), true);
});

test("an expectation matches only the same identified generation", () => {
  assert.equal(isBackendGenerationCompatible("gen-a", "gen-a"), true);
  assert.equal(isBackendGenerationCompatible(" gen-a ", "gen-a"), true, "the expectation is trimmed");
  assert.equal(isBackendGenerationCompatible("gen-a", "gen-b"), false);
  assert.equal(isBackendGenerationCompatible("gen-a", null), false);
  assert.equal(isBackendGenerationCompatible("gen-a", undefined), false);
  assert.equal(isBackendGenerationCompatible("gen-a", ""), false);
});

test("the status payload keeps the expectation visible for diagnostics", () => {
  assert.deepEqual(runtimeGenerationStatus("gen-a", "gen-a"), { pinned: "gen-a", running: "gen-a", matches: true });
  assert.deepEqual(runtimeGenerationStatus("gen-a", "gen-b"), { pinned: "gen-a", running: "gen-b", matches: false });
  assert.deepEqual(runtimeGenerationStatus("", "gen-b"), { pinned: null, running: "gen-b", matches: true });
  assert.deepEqual(runtimeGenerationStatus(" gen-a ", null), { pinned: "gen-a", running: null, matches: false });
  assert.deepEqual(runtimeGenerationStatus(undefined, undefined), { pinned: null, running: null, matches: true });
});
