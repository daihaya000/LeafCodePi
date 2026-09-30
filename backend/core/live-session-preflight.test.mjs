import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isBotTask, liveSessionName, liveSessionWorkspace, preflightLiveSession, resolveSessionPermissionMode,
  resolveSessionSkillPermission,
} from "./live-session-preflight.mjs";

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

test("a Bot task needs both the Bot kind and a Bot id", () => {
  assert.equal(isBotTask({ kind: "bot", botId: "b1" }), true);
  assert.equal(isBotTask({ kind: "bot", botId: null }), false);
  assert.equal(isBotTask({ kind: "bot" }), false);
  assert.equal(isBotTask({ kind: "bot", botId: "" }), false);
  assert.equal(isBotTask({ kind: "code", botId: "b1" }), false);
  assert.equal(isBotTask({ botId: "b1" }), false);
  assert.equal(isBotTask(undefined), false);
});

test("the workspace is the project root when there is one", () => {
  assert.equal(liveSessionWorkspace({ projectRootPath: "/repo", taskDirectory: "/tmp/x" }), "/repo");
  assert.equal(liveSessionWorkspace({ projectRootPath: "/repo", taskDirectory: "/repo" }), "/repo");
  // A project record without a root falls back to the task directory.
  for (const projectRootPath of [undefined, null, ""]) {
    assert.equal(liveSessionWorkspace({ projectRootPath, taskDirectory: "/tmp/x" }), projectRootPath === "" ? "" : "/tmp/x", String(projectRootPath));
  }
});

test("Bot session titles are namespaced", () => {
  assert.equal(liveSessionName({ isBot: true, title: "Review" }), "bot:Review");
  assert.equal(liveSessionName({ isBot: false, title: "Review" }), "Review");
  assert.equal(liveSessionName({ isBot: true, title: "" }), "bot:");
  // Only an explicit true namespaces.
  for (const isBot of [undefined, null, 0, "true"]) {
    assert.equal(liveSessionName({ isBot, title: "Review" }), "Review", String(isBot));
  }
});

test("a normalized skill permission wins over the stored one", () => {
  assert.equal(resolveSessionSkillPermission({ updatedSkillPermission: "allow", taskSkillPermission: "deny" }), "allow");
  assert.equal(resolveSessionSkillPermission({ updatedSkillPermission: "deny", taskSkillPermission: "allow" }), "deny");
  for (const updatedSkillPermission of [undefined, null]) {
    assert.equal(resolveSessionSkillPermission({ updatedSkillPermission, taskSkillPermission: "deny" }), "deny");
  }
  assert.equal(resolveSessionSkillPermission({}), undefined);
});
