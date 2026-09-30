import assert from "node:assert/strict";
import { test } from "node:test";
import { restoredPromptState, restoredTaskMetadata, restoredThroughputState } from "./live-attach-state.mjs";

const deps = {
  createThroughputMap: (initial) => ({ kind: "throughput", initial }),
  createTimingMap: (initial) => ({ kind: "timing", initial }),
};

test("without a replaced live every prompt field starts fresh", async () => {
  const state = restoredPromptState(undefined);
  assert.deepEqual([...state.accountByMessageId], []);
  assert.deepEqual([...state.agentByMessageId], []);
  assert.deepEqual([...state.toolPartialOutputByCallId], []);
  assert.equal(state.promptActive, false);
  assert.equal(state.pendingSettings, undefined);
  assert.equal(state.promptEpoch, 0);
  assert.equal(await state.promptChain, undefined, "a fresh chain resolves immediately");
  // Fresh containers per call: two new lives never share a map.
  assert.notEqual(restoredPromptState(undefined).accountByMessageId, state.accountByMessageId);
});

test("a replaced live keeps its maps, chain, epoch, settings and partial output", () => {
  const accountByMessageId = new Map([["m1", "acc-1"]]);
  const agentByMessageId = new Map([["m1", "reviewer"]]);
  const toolPartialOutputByCallId = new Map([["call-1", "partial"]]);
  const promptChain = Promise.resolve("queued");
  const pendingSettings = { thinkingLevel: "high" };
  const state = restoredPromptState({
    accountByMessageId, agentByMessageId, toolPartialOutputByCallId,
    promptChain, promptActive: true, promptEpoch: 7, pendingSettings,
  });
  assert.equal(state.accountByMessageId, accountByMessageId);
  assert.equal(state.agentByMessageId, agentByMessageId);
  assert.equal(state.toolPartialOutputByCallId, toolPartialOutputByCallId);
  assert.equal(state.promptChain, promptChain, "a queued chain is not replaced");
  assert.equal(state.promptActive, true);
  assert.equal(state.promptEpoch, 7);
  assert.equal(state.pendingSettings, pendingSettings);
  // Explicit falsy values are kept, not defaulted.
  assert.deepEqual(restoredPromptState({ promptActive: false, promptEpoch: 5 }).promptEpoch, 5);
});

test("task metadata prefers the live, then the stored task, then the default", () => {
  const task = { revertLeafId: "leaf-1", manualAbortedAssistantId: "a-1", hangRetryCount: 3 };
  assert.deepEqual(restoredTaskMetadata(undefined, task), {
    revertLeafId: "leaf-1", manualAbortedAssistantId: "a-1", hangRetryCount: 3,
    pendingProviderFallback: null, preserveTaskModel: false,
  });
  assert.deepEqual(restoredTaskMetadata(undefined, undefined), {
    revertLeafId: null, manualAbortedAssistantId: null, hangRetryCount: 0,
    pendingProviderFallback: null, preserveTaskModel: false,
  });
  const live = { revertLeafId: null, manualAbortedAssistantId: "", hangRetryCount: 0, pendingProviderFallback: { at: 1 }, preserveTaskModel: true };
  // `??` falls through on null as well as undefined, so a null revertLeafId in the live
  // still lets the stored task win; "" and 0 are not nullish and do win.
  assert.deepEqual(restoredTaskMetadata(live, task), {
    revertLeafId: "leaf-1", manualAbortedAssistantId: "", hangRetryCount: 0,
    pendingProviderFallback: { at: 1 }, preserveTaskModel: true,
  });
  // preserveTaskModel is only true when it was exactly true.
  assert.equal(restoredTaskMetadata({ ...live, preserveTaskModel: "yes" }, task).preserveTaskModel, false);
});

test("throughput state is restored from the live, else built from the transcript scan", () => {
  const existing = {
    throughputByStartedAt: { id: "live-throughput" },
    persistedThroughputKeys: new Set(["a"]),
    toolStartedAt: { id: "live-started" },
    toolEndedAt: { id: "live-ended" },
  };
  const restored = restoredThroughputState(existing, { timings: [1] }, { startedAt: [2], endedAt: [3] }, deps);
  assert.equal(restored.throughputByStartedAt, existing.throughputByStartedAt);
  assert.equal(restored.persistedThroughputKeys, existing.persistedThroughputKeys);
  assert.equal(restored.toolStartedAt, existing.toolStartedAt);
  assert.equal(restored.toolEndedAt, existing.toolEndedAt);
});

test("a fresh attach builds the versioned maps from the scanned transcript", () => {
  const loaded = { timings: [{ startedAt: 1 }], persistedKeys: new Set(["k"]) };
  const scan = { startedAt: [1], endedAt: [2] };
  assert.deepEqual(restoredThroughputState(undefined, loaded, scan, deps), {
    throughputByStartedAt: { kind: "throughput", initial: loaded.timings },
    persistedThroughputKeys: loaded.persistedKeys,
    toolStartedAt: { kind: "timing", initial: scan.startedAt },
    toolEndedAt: { kind: "timing", initial: scan.endedAt },
  });
  // With nothing scanned, the maps get undefined and the key set is empty.
  const empty = restoredThroughputState(undefined, null, null, deps);
  assert.deepEqual(empty.throughputByStartedAt, { kind: "throughput", initial: undefined });
  assert.deepEqual(empty.toolStartedAt, { kind: "timing", initial: undefined });
  assert.deepEqual([...empty.persistedThroughputKeys], []);
  assert.notEqual(restoredThroughputState(undefined, null, null, deps).persistedThroughputKeys, empty.persistedThroughputKeys);
});
