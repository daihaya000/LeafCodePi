import assert from "node:assert/strict";
import { test } from "node:test";
import { disposeUnattachedSession } from "./live-lifecycle.mjs";

test("the session is disposed exactly once", () => {
  const calls = [];
  disposeUnattachedSession({ id: "s" }, (session) => calls.push(`dispose:${session.id}`));
  assert.deepEqual(calls, ["dispose:s"]);
});

test("the default disposer calls session.dispose()", () => {
  let disposed = 0;
  disposeUnattachedSession({ dispose: () => { disposed += 1; } });
  assert.equal(disposed, 1);
});

test("a disposal failure is swallowed: the caller is already handling another failure", () => {
  let disposed = 0;
  disposeUnattachedSession({ dispose: () => { disposed += 1; throw new Error("dispose failed"); } });
  assert.equal(disposed, 1);
  assert.doesNotThrow(() => disposeUnattachedSession({}, () => { throw new Error("dispose failed"); }));
});

test("a non-Error throw is swallowed as well", () => {
  assert.doesNotThrow(() => disposeUnattachedSession({}, () => { throw "plain failure"; }));
});

test("a session without a dispose method does not throw", () => {
  assert.doesNotThrow(() => disposeUnattachedSession({}));
  assert.doesNotThrow(() => disposeUnattachedSession(undefined));
});
