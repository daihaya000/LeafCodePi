import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  buildPromptOptions, clearSessionQueue, isReasoningMandatoryError, isStaleHarnessPrompt, nextPromptEpoch,
  resolveStreamingBehaviorForPrompt, shouldBypassPromptChain, shouldWaitForSteerStream,
  STEER_STREAM_POLL_MS, STEER_STREAM_WAIT_MS, waitForSessionStreaming,
} from "./prompt-control.mjs";

test("prompt options preserve hang retry, images and streaming precedence", () => {
  assert.deepEqual(buildPromptOptions({ isHangRetry: true, isStreaming: false }), { source: "extension" });
  assert.deepEqual(buildPromptOptions({ isHangRetry: false, isStreaming: true }), { streamingBehavior: "followUp" });
  assert.deepEqual(buildPromptOptions({ isHangRetry: true, isStreaming: true }), { source: "extension" });
  assert.deepEqual(buildPromptOptions({ isHangRetry: false, isStreaming: false, streamingBehavior: "steer" }), { streamingBehavior: "steer" });
  const image = { mimeType: "image/png", data: "abc", ignored: true };
  assert.deepEqual(
    buildPromptOptions({ images: [image], isHangRetry: true, isStreaming: true, streamingBehavior: "steer" }),
    { source: "extension", images: [{ type: "image", data: "abc", mimeType: "image/png" }], streamingBehavior: "steer" },
  );
  assert.deepEqual(buildPromptOptions({ images: [], isHangRetry: false, isStreaming: false }), {});
});

test("only explicit interrupts bypass the chain and late interrupts are dropped", () => {
  assert.equal(shouldBypassPromptChain("steer"), true);
  assert.equal(shouldBypassPromptChain("followUp"), true);
  assert.equal(shouldBypassPromptChain(undefined), false);
  assert.equal(resolveStreamingBehaviorForPrompt("steer", true), "steer");
  assert.equal(resolveStreamingBehaviorForPrompt("followUp", false), undefined);
  assert.equal(shouldWaitForSteerStream({ isStreaming: false, promptActive: true }), true);
  assert.equal(shouldWaitForSteerStream({ isStreaming: true, promptActive: true }), false);
  assert.equal(shouldWaitForSteerStream({ isStreaming: false, promptActive: false }), false);
});

test("stream waiting has the existing defaults, deadline recheck and abort exit", async () => {
  assert.equal(STEER_STREAM_WAIT_MS, 30_000);
  assert.equal(STEER_STREAM_POLL_MS, 50);
  assert.equal(await waitForSessionStreaming(() => true, () => { throw new Error("must not poll"); }), true);
  let streaming = false;
  const sleeps = [];
  assert.equal(await waitForSessionStreaming(() => streaming, () => true, {
    timeoutMs: 100, pollMs: 7, sleep: async (ms) => { sleeps.push(ms); streaming = sleeps.length === 2; },
  }), true);
  assert.deepEqual(sleeps, [7, 7]);
  let active = true;
  assert.equal(await waitForSessionStreaming(() => false, () => active, {
    timeoutMs: 100, sleep: async () => { active = false; },
  }), false);
  // With no time left the stream state is checked once and never slept on.
  let late = false;
  const zeroSleeps = [];
  const sleep = async (ms) => { zeroSleeps.push(ms); };
  assert.equal(await waitForSessionStreaming(() => late, () => true, { timeoutMs: 0, sleep }), false);
  late = true;
  assert.equal(await waitForSessionStreaming(() => late, () => true, { timeoutMs: 0, sleep }), true);
  assert.deepEqual(zeroSleeps, []);
});

test("stream waiting reads clock and timers when called", async () => {
  const originalNow = Date.now;
  const originalTimeout = globalThis.setTimeout;
  let now = 1_000;
  const delays = [];
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay) => { delays.push(delay); now += delay; callback(); return 0; };
  try {
    assert.equal(await waitForSessionStreaming(() => false, () => true, { timeoutMs: 20, pollMs: 10 }), false);
    assert.deepEqual(delays, [10, 10]);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalTimeout;
  }
});

test("prompt epochs invalidate every previous prompt and stay monotonic", () => {
  assert.equal(nextPromptEpoch(undefined), 1);
  assert.equal(nextPromptEpoch(0), 1);
  assert.equal(nextPromptEpoch(7), 8);
  assert.equal(isStaleHarnessPrompt(7, 8), true);
  assert.equal(isStaleHarnessPrompt(8, 8), false);
});

test("queue clearing is optional, safe and warns without throwing", () => {
  const warnings = [];
  let cleared = 0;
  clearSessionQueue({}, (message) => warnings.push(message));
  clearSessionQueue({ clearQueue: () => { cleared += 1; } }, (message) => warnings.push(message));
  clearSessionQueue({ clearQueue: () => { throw new Error("queue failed"); } }, (message) => warnings.push(message));
  clearSessionQueue({ clearQueue: () => { throw "plain failure"; } }, (message) => warnings.push(message));
  assert.equal(cleared, 1);
  assert.deepEqual(warnings, ["[abort] clearQueue failed: queue failed", "[abort] clearQueue failed: plain failure"]);
});

test("mandatory reasoning detection accepts errors and plain values only for that provider message", () => {
  assert.equal(isReasoningMandatoryError(new Error('400: {"message":"Reasoning is mandatory for this endpoint"}')), true);
  assert.equal(isReasoningMandatoryError("REASONING IS MANDATORY"), true);
  assert.equal(isReasoningMandatoryError(new Error("some other error")), false);
  assert.equal(isReasoningMandatoryError(undefined), false);
});

test("plain Node can run prompt control without Web, SDK or session imports", () => {
  const moduleUrl = new URL("./prompt-control.mjs", import.meta.url).href;
  const code = `
    import { buildPromptOptions, nextPromptEpoch } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({ epoch: nextPromptEpoch(1), options: buildPromptOptions({ isHangRetry: false, isStreaming: true }) }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  assert.deepEqual(JSON.parse(output), { epoch: 2, options: { streamingBehavior: "followUp" } });
});
