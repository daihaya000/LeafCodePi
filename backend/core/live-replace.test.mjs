import assert from "node:assert/strict";
import { test } from "node:test";
import { attachReplacementSession, REPLACE_TASK_NOT_FOUND_MESSAGE } from "./live-replace.mjs";

/** `customize` receives the shared order log so overrides can record their calls. */
function fixture(customize = () => ({})) {
  const order = [];
  const deps = {
    persistIdentity: () => { order.push("persist"); return { id: "task" }; },
    attach: async () => { order.push("attach"); return "live"; },
    disposeSession: () => order.push("dispose"),
    restoreIdentity: () => order.push("restore"),
    ...customize(order),
  };
  return { order, deps };
}

test("a successful replacement persists first, attaches, and never disposes the attached session", async () => {
  const f = fixture();
  assert.equal(await attachReplacementSession(f.deps), "live");
  assert.deepEqual(f.order, ["persist", "attach"]);
});

test("a vanished task disposes the unattached session, skips attach and restore, and reports 404", async () => {
  const f = fixture((order) => ({ persistIdentity: () => { order.push("persist"); return undefined; } }));
  await assert.rejects(attachReplacementSession(f.deps), (error) => {
    assert.equal(error.message, REPLACE_TASK_NOT_FOUND_MESSAGE);
    assert.equal(error.status, 404);
    return true;
  });
  assert.deepEqual(f.order, ["persist", "dispose"]);
});

test("an attach failure disposes before restoring identity and rethrows the original error", async () => {
  const failure = new Error("runtime unavailable");
  const f = fixture((order) => ({ attach: async () => { order.push("attach"); throw failure; } }));
  await assert.rejects(attachReplacementSession(f.deps), (error) => error === failure);
  assert.deepEqual(f.order, ["persist", "attach", "dispose", "restore"]);
});

test("replacements without an identity change (SOUL reload) only attach and dispose on failure", async () => {
  const order = [];
  const ok = await attachReplacementSession({ attach: async () => { order.push("attach"); return "live"; }, disposeSession: () => order.push("dispose") });
  assert.equal(ok, "live");
  const failure = new Error("attach failed");
  await assert.rejects(attachReplacementSession({
    attach: async () => { order.push("attach"); throw failure; }, disposeSession: () => order.push("dispose"),
  }), (error) => error === failure);
  assert.deepEqual(order, ["attach", "attach", "dispose"]);
});

test("a synchronous attach throw is handled like an async rejection", async () => {
  const failure = new Error("sync failure");
  const f = fixture((order) => ({ attach: () => { order.push("attach"); throw failure; } }));
  await assert.rejects(attachReplacementSession(f.deps), (error) => error === failure);
  assert.deepEqual(f.order, ["persist", "attach", "dispose", "restore"]);
});

test("a failing restore replaces the attach error but the session was already disposed", async () => {
  const restoreFailure = new Error("restore failed");
  const f = fixture((order) => ({
    attach: async () => { order.push("attach"); throw new Error("attach failed"); },
    restoreIdentity: () => { order.push("restore"); throw restoreFailure; },
  }));
  await assert.rejects(attachReplacementSession(f.deps), (error) => error === restoreFailure);
  assert.deepEqual(f.order, ["persist", "attach", "dispose", "restore"]);
});

test("a persist exception leaves the unattached session to the caller, as before", async () => {
  const failure = new Error("store unavailable");
  const f = fixture(() => ({ persistIdentity: () => { throw failure; } }));
  await assert.rejects(attachReplacementSession(f.deps), (error) => error === failure);
  assert.deepEqual(f.order, []);
});
