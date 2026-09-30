import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightLiveSession, resolveSessionPermissionMode } from "./live-session-preflight.mjs";

test("a live session may be created when nothing stands in the way", () => {
  assert.equal(preflightLiveSession({ hasTask: true, status: "idle", leaseHeldElsewhere: false }), null);
  assert.equal(preflightLiveSession({ hasTask: true, status: "working", leaseHeldElsewhere: false }), null);
  assert.equal(preflightLiveSession({ hasTask: true, status: "error", leaseHeldElsewhere: false }), null);
});

test("a missing task is reported before anything else", () => {
  assert.equal(preflightLiveSession({ hasTask: false, status: "archived", leaseHeldElsewhere: true }), "task-not-found");
  assert.equal(preflightLiveSession({ hasTask: false, status: "idle", leaseHeldElsewhere: false }), "task-not-found");
  // Only an explicit true counts as having the task.
  for (const value of [undefined, null, 0]) {
    assert.equal(preflightLiveSession({ hasTask: value, status: "idle", leaseHeldElsewhere: false }), "task-not-found", String(value));
  }
});

test("an archived task is reported before a busy lease", () => {
  assert.equal(preflightLiveSession({ hasTask: true, status: "archived", leaseHeldElsewhere: true }), "archived");
  assert.equal(preflightLiveSession({ hasTask: true, status: "archived", leaseHeldElsewhere: false }), "archived");
});

test("a lease held elsewhere refuses last and only on an explicit true", () => {
  assert.equal(preflightLiveSession({ hasTask: true, status: "idle", leaseHeldElsewhere: true }), "lease-busy");
  for (const value of [undefined, null, 0, "true"]) {
    assert.equal(preflightLiveSession({ hasTask: true, status: "idle", leaseHeldElsewhere: value }), null, String(value));
  }
});

test("a Bot session follows its own record, falling back to the task", () => {
  const base = { isBot: true, updatedPermissionMode: "deny", taskPermissionMode: "ask" };
  assert.equal(resolveSessionPermissionMode({ ...base, botPermissionMode: "allow" }), "allow");
  assert.equal(resolveSessionPermissionMode({ ...base, botPermissionMode: null }), "ask");
  assert.equal(resolveSessionPermissionMode({ ...base, botPermissionMode: undefined }), "ask");
  assert.equal(resolveSessionPermissionMode({ ...base, botPermissionMode: "deny" }), "deny");
});

test("a Code session uses the normalized task value, falling back to what the task had", () => {
  const base = { isBot: false, botPermissionMode: "deny", taskPermissionMode: "ask" };
  assert.equal(resolveSessionPermissionMode({ ...base, updatedPermissionMode: "allow" }), "allow");
  assert.equal(resolveSessionPermissionMode({ ...base, updatedPermissionMode: null }), "ask");
  assert.equal(resolveSessionPermissionMode({ ...base, updatedPermissionMode: undefined }), "ask");
  // A Bot record never leaks into a Code session.
  assert.equal(resolveSessionPermissionMode({ ...base, updatedPermissionMode: undefined, botPermissionMode: "deny" }), "ask");
});

test("with nothing configured the mode stays undefined", () => {
  assert.equal(resolveSessionPermissionMode({ isBot: false }), undefined);
  assert.equal(resolveSessionPermissionMode({ isBot: true }), undefined);
});
