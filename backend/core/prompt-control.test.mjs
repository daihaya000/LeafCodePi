import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  buildPromptOptions, clearSessionQueue, isReasoningMandatoryError, isStaleHarnessPrompt, nextPromptEpoch,
  canRouteAccountForPrompt, isRecoverableResumeSelectionError, promptSendCustomType, resolveHangWatchQueueAction,
  resolvePromptGate, stillEligibleForAccountRouting,
  resolvePromptPermissionOptions, resolvePromptSendKind, shouldIgnorePromptError,
  shouldArmHangWatchAtSend,
  resolveStreamingBehaviorForPrompt, shouldApplyPromptModelSelection, shouldApplyPromptThinkingLevel,
  shouldBypassPromptChain, shouldForwardBotCodePrompt, shouldWaitForSteerStream,
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

function gates(overrides = {}) {
  const calls = [];
  return {
    calls,
    input: {
      projectArchived: () => { calls.push("project"); return false; },
      forwardToBotCode: () => { calls.push("forward"); return false; },
      leaseOwnedElsewhere: () => { calls.push("lease"); return false; },
      ...overrides,
    },
  };
}

test("a prompt with no obstacle proceeds past every gate", () => {
  const f = gates();
  assert.equal(resolvePromptGate(f.input), null);
  assert.deepEqual(f.calls, ["project", "forward", "lease"]);
});

test("an archived project refuses before the later lookups run", () => {
  const f = gates({ projectArchived: () => { f.calls.push("project"); return true; } });
  assert.equal(resolvePromptGate(f.input), "archived-project");
  assert.deepEqual(f.calls, ["project"]);
});

test("Bot-code forwarding wins over the lease refusal and stops the ladder", () => {
  const f = gates({ forwardToBotCode: () => { f.calls.push("forward"); return true; } });
  assert.equal(resolvePromptGate(f.input), "forward-bot-code");
  assert.deepEqual(f.calls, ["project", "forward"], "the lease is not read when the prompt is forwarded");
});

test("a lease held elsewhere refuses last", () => {
  const f = gates({ leaseOwnedElsewhere: () => { f.calls.push("lease"); return true; } });
  assert.equal(resolvePromptGate(f.input), "lease-busy");
  assert.deepEqual(f.calls, ["project", "forward", "lease"]);
});

test("only a Code task whose Bot is enabled and whose lease is elsewhere forwards", () => {
  const base = { isBot: false, botId: "bot-1", botEnabled: true, leaseHeldElsewhere: true };
  assert.equal(shouldForwardBotCodePrompt(base), true);
  assert.equal(shouldForwardBotCodePrompt({ ...base, isBot: true }), false, "a Bot task never forwards");
  assert.equal(shouldForwardBotCodePrompt({ ...base, botId: undefined }), false);
  assert.equal(shouldForwardBotCodePrompt({ ...base, botId: "" }), false);
  assert.equal(shouldForwardBotCodePrompt({ ...base, botEnabled: false }), false);
  assert.equal(shouldForwardBotCodePrompt({ ...base, botEnabled: undefined }), false);
  assert.equal(shouldForwardBotCodePrompt({ ...base, leaseHeldElsewhere: false }), false);
});

test("the forwarding flags are read truthily, as the record stores them", () => {
  const base = { isBot: false, botId: "bot-1", leaseHeldElsewhere: true };
  assert.equal(shouldForwardBotCodePrompt({ ...base, botEnabled: 1 }), true);
  assert.equal(shouldForwardBotCodePrompt({ ...base, botEnabled: "yes" }), true);
  assert.equal(shouldForwardBotCodePrompt({ ...base, botEnabled: null }), false);
  // Only an explicit true counts for the lease, which is computed by the caller.
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(shouldForwardBotCodePrompt({ ...base, leaseHeldElsewhere: value }), false, String(value));
  }
});

test("a pinned permission wins and Settings only fill the gap for a live session", () => {
  const base = {
    hasLive: true,
    optionPermissionMode: undefined,
    optionSkillPermission: undefined,
    updatedPermissionMode: "allow",
    updatedSkillPermission: "deny",
  };
  assert.deepEqual(resolvePromptPermissionOptions(base), { permissionMode: "allow", skillPermission: "deny" });
  assert.deepEqual(resolvePromptPermissionOptions({ ...base, hasLive: false }), { permissionMode: undefined, skillPermission: undefined });
  assert.deepEqual(resolvePromptPermissionOptions({ ...base, optionPermissionMode: "ask" }), { permissionMode: undefined, skillPermission: "deny" });
  assert.deepEqual(resolvePromptPermissionOptions({ ...base, optionSkillPermission: "allow" }), { permissionMode: "allow", skillPermission: undefined });
  assert.deepEqual(
    resolvePromptPermissionOptions({ ...base, optionPermissionMode: "ask", optionSkillPermission: "allow" }),
    { permissionMode: undefined, skillPermission: undefined },
  );
  // Only an explicit true counts as "has a live session".
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.deepEqual(resolvePromptPermissionOptions({ ...base, hasLive: value }), { permissionMode: undefined, skillPermission: undefined }, String(value));
  }
});

test("the model is only rewritten when the request differs", () => {
  assert.equal(shouldApplyPromptModelSelection({ hasOption: true, matches: false }), true);
  assert.equal(shouldApplyPromptModelSelection({ hasOption: true, matches: true }), false);
  assert.equal(shouldApplyPromptModelSelection({ hasOption: false, matches: false }), false);
});

test("the effort level is rewritten when the model changed or the level differs", () => {
  assert.equal(shouldApplyPromptThinkingLevel({ hasOption: true, modelChanged: true, taskLevel: "high", optionLevel: "high" }), true);
  assert.equal(shouldApplyPromptThinkingLevel({ hasOption: true, modelChanged: false, taskLevel: "high", optionLevel: "low" }), true);
  assert.equal(shouldApplyPromptThinkingLevel({ hasOption: true, modelChanged: false, taskLevel: "high", optionLevel: "high" }), false);
  assert.equal(shouldApplyPromptThinkingLevel({ hasOption: false, modelChanged: true, taskLevel: "high", optionLevel: "low" }), false);
  assert.equal(shouldApplyPromptThinkingLevel({ hasOption: true, modelChanged: false, taskLevel: undefined, optionLevel: undefined }), false);
});

test("only a deleted model or account on resume is recoverable", () => {
  const at = (status, message) => Object.assign(new Error(message), { status });
  assert.equal(isRecoverableResumeSelectionError(at(400, "モデルが見つかりません")), true);
  assert.equal(isRecoverableResumeSelectionError(at(404, "モデルが見つかりません")), true);
  assert.equal(isRecoverableResumeSelectionError(at(404, "アカウントが見つかりません")), true);
  assert.equal(isRecoverableResumeSelectionError(at(400, "アカウントが見つかりません")), true);
  assert.equal(isRecoverableResumeSelectionError(at(500, "モデルが見つかりません")), false);
  assert.equal(isRecoverableResumeSelectionError(at(400, "別のエラー")), false);
  assert.equal(isRecoverableResumeSelectionError(new Error("モデルが見つかりません")), false, "no status is not a selection refusal");
  assert.equal(isRecoverableResumeSelectionError(undefined), false);
});

test("a Code result disarms the hang watch, a steer or skipped rearm keeps it", () => {
  const base = { hasStreamingBehavior: false, isCodeResult: false, skipRearm: false };
  assert.equal(resolveHangWatchQueueAction(base), "arm");
  assert.equal(resolveHangWatchQueueAction({ ...base, hasStreamingBehavior: true }), "keep");
  assert.equal(resolveHangWatchQueueAction({ ...base, skipRearm: true }), "keep");
  assert.equal(resolveHangWatchQueueAction({ ...base, isCodeResult: true }), "disarm");
  assert.equal(resolveHangWatchQueueAction({ ...base, isCodeResult: true, hasStreamingBehavior: true }), "disarm", "a result is never replayed as user input");
  assert.equal(resolveHangWatchQueueAction({ ...base, isCodeResult: true, skipRearm: true }), "disarm");
});

test("only an explicit flag changes the hang-watch action", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(resolveHangWatchQueueAction({ hasStreamingBehavior: value, isCodeResult: false, skipRearm: false }), "arm", String(value));
    assert.equal(resolveHangWatchQueueAction({ hasStreamingBehavior: false, isCodeResult: value, skipRearm: false }), "arm", String(value));
    assert.equal(resolveHangWatchQueueAction({ hasStreamingBehavior: false, isCodeResult: false, skipRearm: value }), "arm", String(value));
    assert.equal(shouldArmHangWatchAtSend({ skipRearm: value }), false, String(value));
  }
  assert.equal(shouldArmHangWatchAtSend({ skipRearm: true }), true);
});

test("an internal turn is sent as its own hidden custom message, a normal one as a prompt", () => {
  const base = { isCodeResult: false, isProviderFallback: false, isTransportRecovery: false };
  assert.equal(resolvePromptSendKind(base), "prompt");
  assert.equal(resolvePromptSendKind({ ...base, isCodeResult: true }), "code-result");
  assert.equal(resolvePromptSendKind({ ...base, isProviderFallback: true }), "provider-fallback");
  assert.equal(resolvePromptSendKind({ ...base, isTransportRecovery: true }), "transport-recovery");
  assert.equal(
    resolvePromptSendKind({ isCodeResult: true, isProviderFallback: true, isTransportRecovery: true }),
    "code-result",
    "a Code result wins: it is never replayed as user input",
  );
  assert.equal(resolvePromptSendKind({ isCodeResult: false, isProviderFallback: true, isTransportRecovery: true }), "provider-fallback");
});

test("only an explicit flag selects an internal send kind", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(resolvePromptSendKind({ isCodeResult: value, isProviderFallback: false, isTransportRecovery: false }), "prompt", String(value));
    assert.equal(resolvePromptSendKind({ isCodeResult: false, isProviderFallback: value, isTransportRecovery: false }), "prompt", String(value));
    assert.equal(resolvePromptSendKind({ isCodeResult: false, isProviderFallback: false, isTransportRecovery: value }), "prompt", String(value));
  }
});

test("each internal send kind maps to its own custom type and a plain prompt to none", () => {
  const types = { codeResult: "bot-code-result", providerFallback: "leafcode-pi.provider-fallback", transportRecovery: "leafcode-pi.provider-transport-recovery" };
  assert.equal(promptSendCustomType("code-result", types), types.codeResult);
  assert.equal(promptSendCustomType("provider-fallback", types), types.providerFallback);
  assert.equal(promptSendCustomType("transport-recovery", types), types.transportRecovery);
  assert.equal(promptSendCustomType("prompt", types), null);
  assert.equal(promptSendCustomType("unknown", types), null);
});

test("a prompt error after a user abort is not reported as a task failure", () => {
  assert.equal(shouldIgnorePromptError({ isAbortMessage: true, hasManualAbort: true }), true);
  assert.equal(shouldIgnorePromptError({ isAbortMessage: true, hasManualAbort: false }), false);
  assert.equal(shouldIgnorePromptError({ isAbortMessage: false, hasManualAbort: true }), false);
  assert.equal(shouldIgnorePromptError({ isAbortMessage: false, hasManualAbort: false }), false);
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(shouldIgnorePromptError({ isAbortMessage: value, hasManualAbort: true }), false, String(value));
    assert.equal(shouldIgnorePromptError({ isAbortMessage: true, hasManualAbort: value }), false, String(value));
  }
});

const routing = (overrides = {}) => ({
  reroute: true,
  hasProviderId: true,
  hasModelId: true,
  isStreaming: false,
  isGoalLoopTurn: false,
  hasUserMessage: true,
  isAccountRoutingProvider: true,
  accountRoutingMode: "integrated",
  accountIdExplicit: false,
  ...overrides,
});

test("routing needs a reroute request, a provider/model, an idle session and an integrated account", () => {
  assert.equal(canRouteAccountForPrompt(routing()), true);
  assert.equal(canRouteAccountForPrompt(routing({ reroute: false })), false);
  assert.equal(canRouteAccountForPrompt(routing({ hasProviderId: false })), false);
  assert.equal(canRouteAccountForPrompt(routing({ hasModelId: false })), false);
  assert.equal(canRouteAccountForPrompt(routing({ isStreaming: true })), false);
  assert.equal(canRouteAccountForPrompt(routing({ isAccountRoutingProvider: false })), false);
  assert.equal(canRouteAccountForPrompt(routing({ accountRoutingMode: "separate" })), false);
  assert.equal(canRouteAccountForPrompt(routing({ accountRoutingMode: undefined })), false);
});

test("a pinned account is never routed, and a turn needs a user message or a Goal Loop", () => {
  assert.equal(canRouteAccountForPrompt(routing({ accountIdExplicit: true })), false);
  assert.equal(canRouteAccountForPrompt(routing({ hasUserMessage: false })), false);
  assert.equal(canRouteAccountForPrompt(routing({ hasUserMessage: false, isGoalLoopTurn: true })), true, "a Goal Loop turn has its own history");
});

test("the re-check inside the route lock drops the request flag but keeps every other condition", () => {
  const base = {
    hasProviderId: true, hasModelId: true, isAccountRoutingProvider: true, accountRoutingMode: "integrated",
    accountIdExplicit: false, isStreaming: false, isGoalLoopTurn: false, hasUserMessage: true,
  };
  assert.equal(stillEligibleForAccountRouting(base), true);
  assert.equal(stillEligibleForAccountRouting({ ...base, accountIdExplicit: true }), false, "a pin that appeared while waiting stops routing");
  assert.equal(stillEligibleForAccountRouting({ ...base, isStreaming: true }), false);
  assert.equal(stillEligibleForAccountRouting({ ...base, hasModelId: false }), false);
  assert.equal(stillEligibleForAccountRouting({ ...base, hasUserMessage: false }), false);
  assert.equal(stillEligibleForAccountRouting({ ...base, hasUserMessage: false, isGoalLoopTurn: true }), true);
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(stillEligibleForAccountRouting({ ...base, accountIdExplicit: value }), true, String(value));
    assert.equal(stillEligibleForAccountRouting({ ...base, isStreaming: value }), true, String(value));
  }
});
