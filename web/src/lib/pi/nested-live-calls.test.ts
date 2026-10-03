import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { liveNestedCallsFor, trackNestedToolEvent, type LiveNestedCalls } from "./nested-live-calls";
import { trackThroughputEvent } from "./harness";

const start = (id: string, name: string, parent = "p1") => ({
  type: "tool_execution_start", toolCallId: id, toolName: name, args: { path: "secret.txt" }, parentToolCallId: parent,
});
const end = (id: string, name: string, extra: Record<string, unknown> = {}, parent = "p1") => ({
  type: "tool_execution_end", toolCallId: id, toolName: name, parentToolCallId: parent,
  result: { content: [{ type: "text", text: "done" }] }, isError: false, ...extra,
});

describe("trackNestedToolEvent", () => {
  it("follows a call from running to finished with its duration, and never keeps arguments", () => {
    const store: LiveNestedCalls = new Map();
    assert.equal(trackNestedToolEvent(store, start("p1/1", "read"), 1_000), true);
    assert.deepEqual(liveNestedCallsFor(store, "p1"), [{ id: "p1/1", name: "read", status: "unfinished" }]);
    assert.equal(trackNestedToolEvent(store, end("p1/1", "read"), 1_250), true);
    assert.deepEqual(liveNestedCallsFor(store, "p1"), [{ id: "p1/1", name: "read", status: "ok", durationMs: 250 }]);
    assert.equal(JSON.stringify([...store]).includes("secret.txt"), false);
  });

  it("records a failed call with its clipped error text", () => {
    const store: LiveNestedCalls = new Map();
    trackNestedToolEvent(store, start("p1/1", "powershell"), 0);
    trackNestedToolEvent(store, end("p1/1", "powershell", { isError: true, result: { content: [{ type: "text", text: "e".repeat(900) }] } }), 5);
    const [call] = liveNestedCallsFor(store, "p1");
    assert.equal(call?.status, "error");
    assert.equal(call?.error?.length, 500);
  });

  it("ignores top-level events and unknown calls, and bounds what it keeps", () => {
    const store: LiveNestedCalls = new Map();
    assert.equal(trackNestedToolEvent(store, { type: "tool_execution_start", toolCallId: "t1", toolName: "read" }), false);
    assert.equal(trackNestedToolEvent(store, end("p1/9", "read")), true);
    assert.equal(store.size, 0);
    for (let index = 0; index < 300; index += 1) trackNestedToolEvent(store, start(`p1/${index}`, "read"));
    assert.equal(liveNestedCallsFor(store, "p1").length, 256);
    for (let index = 0; index < 80; index += 1) trackNestedToolEvent(store, start(`q${index}/1`, "read", `q${index}`));
    assert.equal(store.size <= 64, true);
    assert.deepEqual(liveNestedCallsFor(undefined, "p1"), []);
  });
});

describe("harness event tracking", () => {
  function live() {
    return {
      toolStartedAt: new Map(), toolEndedAt: new Map(), toolPartialOutputByCallId: new Map(),
      throughputByStartedAt: new Map(), persistedThroughputKeys: new Set(),
    } as unknown as Parameters<typeof trackThroughputEvent>[0];
  }

  it("keeps nested calls out of the per-call maps and drops them when the parent result lands", () => {
    const state = live();
    trackThroughputEvent(state, { type: "tool_execution_start", toolCallId: "p1", toolName: "codemode", args: {} });
    trackThroughputEvent(state, start("p1/1", "read"));
    trackThroughputEvent(state, { type: "tool_execution_update", toolCallId: "p1/1", toolName: "read", partialResult: { content: [] }, parentToolCallId: "p1" });
    trackThroughputEvent(state, end("p1/1", "read"));
    assert.deepEqual([...state.toolStartedAt.keys()], ["p1"]);
    assert.equal(state.toolEndedAt.size, 0);
    assert.equal(state.toolPartialOutputByCallId.size, 0);
    assert.equal(liveNestedCallsFor(state.nestedToolCalls, "p1")[0]?.status, "ok");

    trackThroughputEvent(state, { type: "message_end", message: { role: "toolResult", toolCallId: "p1" } });
    assert.equal(state.nestedToolCalls?.has("p1"), false);
  });
});
