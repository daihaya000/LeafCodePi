import assert from "node:assert/strict";
import { test } from "node:test";
import { isRegisteredLive, isStaleEnsureEpoch } from "./live-lifecycle.mjs";

test("a missing epoch entry counts as generation 0", () => {
  assert.equal(isStaleEnsureEpoch(undefined, 0), false);
  assert.equal(isStaleEnsureEpoch(null, 0), false);
  assert.equal(isStaleEnsureEpoch(undefined, 1), true);
  assert.equal(isStaleEnsureEpoch(null, 1), true);
  // A stored 0 is the same generation as a missing entry.
  assert.equal(isStaleEnsureEpoch(0, 0), false);
});

test("the attempt is stale whenever the generation moved on", () => {
  assert.equal(isStaleEnsureEpoch(1, 1), false);
  assert.equal(isStaleEnsureEpoch(2, 1), true, "a dispose bumped the epoch");
  assert.equal(isStaleEnsureEpoch(1, 2), true, "a newer attempt owns the current generation");
  assert.equal(isStaleEnsureEpoch(5, 5), false);
});

test("only the exact attached live counts as still registered", () => {
  const attached = { id: "attached" };
  const newer = { id: "newer" };
  assert.equal(isRegisteredLive(() => attached, attached), true);
  assert.equal(isRegisteredLive(() => newer, attached), false, "a newer live replaced ours");
  assert.equal(isRegisteredLive(() => undefined, attached), false, "our live was removed already");
  assert.equal(isRegisteredLive(() => ({ id: "attached" }), attached), false, "identity, not shape");
});

test("the registry is read at call time", () => {
  let current = { id: "attached" };
  const attached = current;
  const getLive = () => current;
  assert.equal(isRegisteredLive(getLive, attached), true);
  current = { id: "replaced" };
  assert.equal(isRegisteredLive(getLive, attached), false);
});
