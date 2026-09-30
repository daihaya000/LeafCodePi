import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionIdentityPatch } from "./session-identity.mjs";

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
