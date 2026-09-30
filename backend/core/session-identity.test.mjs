import assert from "node:assert/strict";
import { test } from "node:test";
import { hasIdentityChanges, sessionIdentityPatch, sessionIdentitySource } from "./session-identity.mjs";

const task = { sessionId: "session-1", sessionFile: "file-1", providerID: "p", modelID: "m" };

test("an unchanged identity produces no patch at all", () => {
  assert.deepEqual(sessionIdentityPatch(task, { ...task }), {});
  assert.deepEqual(sessionIdentityPatch(task, { sessionId: "session-1", sessionFile: "file-1", providerID: "p", modelID: "m" }), {});
});

test("only the changed fields are returned", () => {
  assert.deepEqual(sessionIdentityPatch(task, { ...task, modelID: "m2" }), { modelID: "m2" });
  assert.deepEqual(sessionIdentityPatch(task, { sessionId: "session-2" }), { sessionId: "session-2" });
  assert.deepEqual(sessionIdentityPatch(task, { sessionFile: "file-2" }), { sessionFile: "file-2" });
  assert.deepEqual(sessionIdentityPatch(task, { providerID: "p2" }), { providerID: "p2" });
  assert.deepEqual(sessionIdentityPatch(task, { providerID: "p2", modelID: "m2" }), { providerID: "p2", modelID: "m2" });
});

test("a missing session id or file never erases the persisted one", () => {
  assert.deepEqual(sessionIdentityPatch(task, {}), {});
  assert.deepEqual(sessionIdentityPatch(task, { sessionId: null, sessionFile: null }), {});
  assert.deepEqual(sessionIdentityPatch(task, { sessionId: undefined, sessionFile: undefined }), {});
  // An empty string is a value, so it does replace what was stored.
  assert.deepEqual(sessionIdentityPatch(task, { sessionId: "", sessionFile: "" }), { sessionId: "", sessionFile: "" });
});

test("a runtime without model identity leaves the stored provider and model alone", () => {
  assert.deepEqual(sessionIdentityPatch(task, { sessionId: task.sessionId }), {});
  assert.deepEqual(sessionIdentityPatch(task, { sessionId: task.sessionId, providerID: undefined, modelID: undefined }), {});
  // Absent provider but a present model is still recorded.
  assert.deepEqual(sessionIdentityPatch(task, { modelID: "m2" }), { modelID: "m2" });
});

test("an empty string provider or model still replaces the stored value", () => {
  assert.deepEqual(sessionIdentityPatch(task, { providerID: "" }), { providerID: "" });
  assert.deepEqual(sessionIdentityPatch(task, { modelID: "" }), { modelID: "" });
});

test("a task without stored values is filled in from the runtime", () => {
  const fresh = { sessionId: null, sessionFile: null, providerID: undefined, modelID: undefined };
  assert.deepEqual(sessionIdentityPatch(fresh, { sessionId: "s", sessionFile: "f", providerID: "p", modelID: "m" }), {
    sessionId: "s", sessionFile: "f", providerID: "p", modelID: "m",
  });
});

test("the returned patch is a fresh object and never the identity passed in", () => {
  const identity = { sessionId: "session-2", sessionFile: "file-2", providerID: "p2", modelID: "m2" };
  const patch = sessionIdentityPatch(task, identity);
  assert.notEqual(patch, identity);
  assert.deepEqual(patch, identity);
  patch.modelID = "changed";
  assert.equal(identity.modelID, "m2");
});

test("a preserved task model reports only the transcript location", () => {
  const runtime = { sessionId: "s", sessionFile: "f", providerID: "p2", modelID: "m2" };
  assert.deepEqual(sessionIdentitySource({ ...runtime, preserveTaskModel: true }), { sessionId: "s", sessionFile: "f" });
  assert.deepEqual(sessionIdentitySource({ ...runtime, preserveTaskModel: false }), { providerID: "p2", modelID: "m2", sessionId: "s", sessionFile: "f" });
  // Only an explicit true preserves; anything else tracks the model.
  for (const flag of [undefined, null, 0, "true"]) {
    assert.deepEqual(sessionIdentitySource({ ...runtime, preserveTaskModel: flag }), { providerID: "p2", modelID: "m2", sessionId: "s", sessionFile: "f" }, String(flag));
  }
  // Missing runtime values are forwarded as undefined and never erase anything downstream.
  const source = sessionIdentitySource({ preserveTaskModel: false, sessionId: task.sessionId });
  assert.deepEqual(source, { providerID: undefined, modelID: undefined, sessionId: task.sessionId, sessionFile: undefined });
  assert.deepEqual(sessionIdentityPatch(task, source), {});
  assert.equal(hasIdentityChanges(sessionIdentityPatch(task, source)), false);
});

test("a preserved model still records a new transcript location on the task", () => {
  const source = sessionIdentitySource({ preserveTaskModel: true, sessionId: "session-2", sessionFile: undefined, providerID: "p2", modelID: "m2" });
  const patch = sessionIdentityPatch(task, source);
  assert.deepEqual(patch, { sessionId: "session-2" });
  assert.equal(hasIdentityChanges(patch), true);
});

test("hasIdentityChanges only reports a non-empty patch", () => {
  assert.equal(hasIdentityChanges({}), false);
  assert.equal(hasIdentityChanges({ modelID: "m" }), true);
  // A key present but undefined still counts as a key, matching Object.keys semantics.
  assert.equal(hasIdentityChanges({ modelID: undefined }), true);
});
