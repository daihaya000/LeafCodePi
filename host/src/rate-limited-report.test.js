import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimitedReporter } from "./rate-limited-report.js";

test("a repeated failure is reported once per interval with the suppressed count", () => {
  let time = 0;
  const lines = [];
  const reporter = createRateLimitedReporter({ report: (line) => lines.push(line), intervalMs: 1_000, now: () => time });
  assert.equal(reporter.failure("menu", new Error("boom")), true);
  time = 500;
  assert.equal(reporter.failure("menu", new Error("boom")), false);
  assert.equal(reporter.failure("menu", "again"), false);
  assert.deepEqual(lines, ["menu failed: boom"]);
  time = 1_000;
  assert.equal(reporter.failure("menu", new Error("boom")), true);
  assert.deepEqual(lines.at(-1), "menu failed: boom (2 similar failures suppressed)");
});

test("keys are independent and a success makes the next failure report immediately", () => {
  let time = 0;
  const lines = [];
  const reporter = createRateLimitedReporter({ report: (line) => lines.push(line), intervalMs: 10_000, now: () => time });
  reporter.failure("a", new Error("x"));
  assert.equal(reporter.failure("b", new Error("y")), true);
  assert.equal(reporter.failure("a", new Error("x")), false);
  reporter.success("a");
  time = 1;
  assert.equal(reporter.failure("a", new Error("x")), true);
  assert.equal(lines.length, 3);
});