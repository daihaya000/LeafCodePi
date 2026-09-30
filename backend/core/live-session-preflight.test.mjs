import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isBotTask, liveSessionName, liveSessionRefusalError, liveSessionWorkspace, preflightLiveSession,
  resolveSessionAccountId,
  resolveSessionAccountRefusal, resolveSessionPermissionMode, resolveSessionSkillPermission,
  resolveSessionThinkingLevelSource, resolveStoredModelOutcome, TASK_ARCHIVED_MESSAGE,
  TASK_NOT_FOUND_MESSAGE,
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

const account = (overrides = {}) => ({
  explicit: true, hasTaskAccountId: true, hasAccountRecord: true, accountEnabled: true, ...overrides,
});

test("a valid stored thinking level wins over the model default", () => {
  assert.equal(resolveSessionThinkingLevelSource({ hasStoredLevel: true, hasModel: true }), "stored");
  assert.equal(resolveSessionThinkingLevelSource({ hasStoredLevel: true, hasModel: false }), "stored");
});

test("without a valid stored level the model default applies, or nothing without a model", () => {
  assert.equal(resolveSessionThinkingLevelSource({ hasStoredLevel: false, hasModel: true }), "model-default");
  assert.equal(resolveSessionThinkingLevelSource({ hasStoredLevel: false, hasModel: false }), "none");
});

test("only an explicit true counts for the stored-level and model flags", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(resolveSessionThinkingLevelSource({ hasStoredLevel: value, hasModel: true }), "model-default", String(value));
    assert.equal(resolveSessionThinkingLevelSource({ hasStoredLevel: false, hasModel: value }), "none", String(value));
  }
});

test("a stored model that loaded, or no stored model at all, needs no fallback", () => {
  assert.equal(resolveStoredModelOutcome({ hasStoredModel: true, resolved: true, autoFallback: false }), "resolved");
  assert.equal(resolveStoredModelOutcome({ hasStoredModel: true, resolved: true, autoFallback: true }), "resolved");
  assert.equal(resolveStoredModelOutcome({ hasStoredModel: false, resolved: false, autoFallback: false }), "resolved");
  assert.equal(resolveStoredModelOutcome({ hasStoredModel: false, resolved: false, autoFallback: true }), "resolved");
});

test("an unresolved stored model is replaced by Auto only when one was found", () => {
  assert.equal(resolveStoredModelOutcome({ hasStoredModel: true, resolved: false, autoFallback: true }), "auto-fallback");
  assert.equal(resolveStoredModelOutcome({ hasStoredModel: true, resolved: false, autoFallback: false }), "unavailable");
});

test("only an explicit true counts for the stored-model and fallback flags", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(resolveStoredModelOutcome({ hasStoredModel: value, resolved: false, autoFallback: false }), "resolved", String(value));
    assert.equal(resolveStoredModelOutcome({ hasStoredModel: true, resolved: false, autoFallback: value }), "unavailable", String(value));
  }
});

test("an explicitly chosen account refuses when it is missing or paused", () => {
  assert.equal(resolveSessionAccountRefusal(account()), null);
  assert.equal(resolveSessionAccountRefusal(account({ hasAccountRecord: false })), "account-not-found");
  assert.equal(resolveSessionAccountRefusal(account({ accountEnabled: false })), "account-paused");
  // A missing record is reported before the paused state can be considered.
  assert.equal(resolveSessionAccountRefusal(account({ hasAccountRecord: false, accountEnabled: false })), "account-not-found");
});

test("an inherited account never refuses, it just falls back", () => {
  for (const input of [account({ explicit: false }), account({ explicit: false, hasAccountRecord: false, accountEnabled: false })]) {
    assert.equal(resolveSessionAccountRefusal(input), null);
  }
  assert.equal(resolveSessionAccountRefusal(account({ hasTaskAccountId: false, hasAccountRecord: false })), null);
  for (const explicit of [undefined, null, 0, "true"]) {
    assert.equal(resolveSessionAccountRefusal(account({ explicit })), null, String(explicit));
  }
});

const selection = (overrides = {}) => ({
  hasAccountRecord: true, accountEnabled: true, hasProviderId: true,
  routedThroughAccounts: true, accountHasProvider: true, taskAccountId: "acc-1", ...overrides,
});

test("the resolved route account always wins", () => {
  assert.equal(resolveSessionAccountId({ ...selection({ modelRouteAccountId: "acc-2" }) }), "acc-2");
  assert.equal(resolveSessionAccountId({ ...selection({ modelRouteAccountId: "acc-2", accountEnabled: false }) }), "acc-2");
  // A null route account is not a choice, so the task account is considered.
  assert.equal(resolveSessionAccountId({ ...selection({ modelRouteAccountId: null }) }), "acc-1");
  assert.equal(resolveSessionAccountId({ ...selection({ modelRouteAccountId: undefined }) }), "acc-1");
});

test("the task account is reused only when it is present, enabled and covers the provider", () => {
  assert.equal(resolveSessionAccountId(selection()), "acc-1");
  assert.equal(resolveSessionAccountId(selection({ hasAccountRecord: false })), null);
  assert.equal(resolveSessionAccountId(selection({ accountEnabled: false })), null);
  assert.equal(resolveSessionAccountId(selection({ accountHasProvider: false })), null);
  assert.equal(resolveSessionAccountId(selection({ routedThroughAccounts: false })), null);
  // A task without a provider only needs an enabled account.
  assert.equal(resolveSessionAccountId(selection({ hasProviderId: false })), "acc-1");
  assert.equal(resolveSessionAccountId(selection({ hasProviderId: false, routedThroughAccounts: false, accountHasProvider: false })), "acc-1");
  assert.equal(resolveSessionAccountId(selection({ hasProviderId: false, accountEnabled: false })), null);
  // No task account at all means the ambient auth path.
  assert.equal(resolveSessionAccountId(selection({ taskAccountId: null })), null);
});

test("only an explicit true enables the account flags", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(resolveSessionAccountId(selection({ accountEnabled: value })), null, String(value));
    assert.equal(resolveSessionAccountId(selection({ routedThroughAccounts: value })), null, String(value));
    assert.equal(resolveSessionAccountId(selection({ accountHasProvider: false, routedThroughAccounts: value })), null, String(value));
  }
});

test("a refusal maps to the status and wording every entry point reports", () => {
  const lease = { leaseBusyMessage: "タスクは別のワーカーで実行中です" };
  assert.deepEqual(liveSessionRefusalError("task-not-found", lease), { status: 404, message: TASK_NOT_FOUND_MESSAGE });
  assert.deepEqual(liveSessionRefusalError("archived", lease), { status: 409, message: TASK_ARCHIVED_MESSAGE });
  assert.deepEqual(liveSessionRefusalError("lease-busy", lease), { status: 409, message: lease.leaseBusyMessage });
  assert.equal(TASK_NOT_FOUND_MESSAGE, "タスクが見つかりません");
  assert.equal(TASK_ARCHIVED_MESSAGE, "アーカイブされたタスクです");
});

test("the lease wording is passed in, so the worker API keeps its own phrasing", () => {
  assert.equal(liveSessionRefusalError("lease-busy", { leaseBusyMessage: "custom" }).message, "custom");
  // Nothing to report still resolves to the busy status, which callers never reach
  // because preflight returns null first.
  assert.deepEqual(liveSessionRefusalError(null, { leaseBusyMessage: "custom" }), { status: 409, message: "custom" });
});

test("the refusal ladder feeds the error mapping in precedence order", () => {
  const input = { hasTask: false, status: "archived", leaseHeldElsewhere: true };
  assert.equal(liveSessionRefusalError(preflightLiveSession(input), { leaseBusyMessage: "x" }).status, 404);
  assert.equal(liveSessionRefusalError(preflightLiveSession({ ...input, hasTask: true }), { leaseBusyMessage: "x" }).status, 409);
  assert.equal(liveSessionRefusalError(preflightLiveSession({ hasTask: true, status: "idle", leaseHeldElsewhere: true }), { leaseBusyMessage: "x" }).message, "x");
});
