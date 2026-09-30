import assert from "node:assert/strict";
import { test } from "node:test";
import { hasOtherBusyRoomLive, oneToOneBotIdFromTaskId, resolveAttachAccount, shouldShutdownOnDispose } from "./live-lifecycle.mjs";

const live = (overrides = {}) => ({ promptActive: false, session: { isStreaming: false, isCompacting: false }, ...overrides });

test("only other sessions of the same Room Bot count as busy, using any busy signal", () => {
  const entries = (map) => Object.entries(map);
  assert.equal(hasOtherBusyRoomLive("bot:one:room:a", "one", entries({ "bot:one:room:a": live({ promptActive: true }) })), false);
  assert.equal(hasOtherBusyRoomLive("bot:one:room:a", "one", entries({ "bot:one:room:b": live() })), false);
  assert.equal(hasOtherBusyRoomLive("bot:one:room:a", "one", entries({ "bot:one:room:b": live({ promptActive: true }) })), true);
  assert.equal(hasOtherBusyRoomLive("bot:one:room:a", "one", entries({ "bot:one:room:b": live({ session: { isStreaming: true } }) })), true);
  assert.equal(hasOtherBusyRoomLive("bot:one:room:a", "one", entries({ "bot:one:room:b": live({ session: { isCompacting: true } }) })), true);
  assert.equal(hasOtherBusyRoomLive("bot:one:room:a", "one", entries({
    "bot:two:room:a": live({ promptActive: true }), "bot:one": live({ promptActive: true }), "bot:one:roomx": live({ promptActive: true }),
  })), false);
  assert.equal(hasOtherBusyRoomLive("bot:one:room:a", "one", []), false);
});

test("Room busy detection accepts any iterable of entries, such as a Map", () => {
  const map = new Map([["bot:one:room:b", live({ promptActive: true })]]);
  assert.equal(hasOtherBusyRoomLive("bot:one:room:a", "one", map), true);
});

function shutdownProbe(values) {
  const calls = [];
  const thunk = (name, value) => () => { calls.push(name); if (value instanceof Error) throw value; return value; };
  return {
    calls,
    input: {
      shutdownEmitted: values.shutdownEmitted ?? false,
      hasShutdownHandler: thunk("handler", values.handler ?? true),
      isBusyOrGoalLoopActive: thunk("busy", values.busy ?? false),
      isGoalLoopOwned: thunk("owned", values.owned ?? false),
    },
  };
}

test("an idle session without a Goal Loop owner shuts down extensions, evaluating every check in order", () => {
  const probe = shutdownProbe({});
  assert.equal(shouldShutdownOnDispose(probe.input), true);
  assert.deepEqual(probe.calls, ["handler", "busy", "owned"]);
});

test("each reason to skip shutdown short-circuits the later, more expensive checks", () => {
  const emitted = shutdownProbe({ shutdownEmitted: true });
  assert.equal(shouldShutdownOnDispose(emitted.input), false);
  assert.deepEqual(emitted.calls, []);
  const noHandler = shutdownProbe({ handler: false });
  assert.equal(shouldShutdownOnDispose(noHandler.input), false);
  assert.deepEqual(noHandler.calls, ["handler"]);
  const busy = shutdownProbe({ busy: true });
  assert.equal(shouldShutdownOnDispose(busy.input), false);
  assert.deepEqual(busy.calls, ["handler", "busy"]);
  const owned = shutdownProbe({ owned: true });
  assert.equal(shouldShutdownOnDispose(owned.input), false);
  assert.deepEqual(owned.calls, ["handler", "busy", "owned"]);
});

test("a failing check means do not wait for shutdown, and undefined emitted flag is not emitted", () => {
  for (const values of [{ handler: new Error("runner missing") }, { busy: new Error("state") }, { owned: new Error("goal state unreadable") }]) {
    assert.equal(shouldShutdownOnDispose(shutdownProbe(values).input), false);
  }
  assert.equal(shouldShutdownOnDispose({ ...shutdownProbe({}).input, shutdownEmitted: undefined }), true);
});

test("only 1:1 Bot task ids are resident-promotion candidates, never Room or Code ids", () => {
  assert.equal(oneToOneBotIdFromTaskId("bot:one"), "one");
  assert.equal(oneToOneBotIdFromTaskId("bot:one:room:main"), null);
  assert.equal(oneToOneBotIdFromTaskId("bot:"), null);
  assert.equal(oneToOneBotIdFromTaskId("code-task"), null);
  assert.equal(oneToOneBotIdFromTaskId("xbot:one"), null);
});

test("attach account: the task account is acquired unless the replaced live already holds it", () => {
  assert.deepEqual(resolveAttachAccount({ taskAccountId: "a" }), { accountId: "a", acquire: true });
  assert.deepEqual(resolveAttachAccount({ taskAccountId: "a", existingAccountId: "a" }), { accountId: "a", acquire: false });
  assert.deepEqual(resolveAttachAccount({ taskAccountId: "a", existingAccountId: "b" }), { accountId: "a", acquire: true });
  assert.deepEqual(resolveAttachAccount({}), { accountId: null, acquire: false });
  assert.deepEqual(resolveAttachAccount({ taskAccountId: null, existingAccountId: "a" }), { accountId: null, acquire: false });
});

test("attach account: an explicit session account overrides the task account, including explicit null", () => {
  assert.deepEqual(resolveAttachAccount({ sessionAccountId: "s", taskAccountId: "t" }), { accountId: "s", acquire: true });
  assert.deepEqual(resolveAttachAccount({ sessionAccountId: "s", taskAccountId: "t", existingAccountId: "s" }), { accountId: "s", acquire: false });
  assert.deepEqual(resolveAttachAccount({ sessionAccountId: null, taskAccountId: "t", existingAccountId: "t" }), { accountId: null, acquire: false });
  assert.deepEqual(resolveAttachAccount({ sessionAccountId: undefined, taskAccountId: "t" }), { accountId: "t", acquire: true });
  assert.deepEqual(resolveAttachAccount({ sessionAccountId: "", taskAccountId: "t" }), { accountId: "", acquire: false });
});
