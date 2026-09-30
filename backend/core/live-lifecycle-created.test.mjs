import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAttachedSessionAction, resolveCreatedSessionAction } from "./live-lifecycle.mjs";

test("a freshly created session is attached when its generation is current and the task exists", () => {
  assert.equal(resolveCreatedSessionAction({ staleGeneration: false, hasTask: true }), "attach");
});

test("a stale generation wins over a vanished task", () => {
  assert.equal(resolveCreatedSessionAction({ staleGeneration: true, hasTask: true }), "retry");
  assert.equal(resolveCreatedSessionAction({ staleGeneration: true, hasTask: false }), "retry");
});

test("a current generation with no task left is reported as not-found", () => {
  assert.equal(resolveCreatedSessionAction({ staleGeneration: false, hasTask: false }), "not-found");
  for (const hasTask of [undefined, null, 0]) {
    assert.equal(resolveCreatedSessionAction({ staleGeneration: false, hasTask }), "not-found", String(hasTask));
  }
});

test("only an explicit true counts as a stale generation", () => {
  for (const staleGeneration of [undefined, null, 0, "true", 1]) {
    assert.equal(resolveCreatedSessionAction({ staleGeneration, hasTask: true }), "attach", String(staleGeneration));
    assert.equal(resolveAttachedSessionAction({ staleGeneration, isRegistered: true }), "keep", String(staleGeneration));
  }
});

test("a current generation keeps the attached live", () => {
  assert.equal(resolveAttachedSessionAction({ staleGeneration: false, isRegistered: true }), "keep");
  assert.equal(resolveAttachedSessionAction({ staleGeneration: false, isRegistered: false }), "keep");
});

test("a stale generation retries, disposing only the live it attached", () => {
  assert.equal(resolveAttachedSessionAction({ staleGeneration: true, isRegistered: true }), "dispose-and-retry");
  assert.equal(resolveAttachedSessionAction({ staleGeneration: true, isRegistered: false }), "retry");
  for (const isRegistered of [undefined, null, 0, "true"]) {
    assert.equal(resolveAttachedSessionAction({ staleGeneration: true, isRegistered }), "retry", String(isRegistered));
  }
});
