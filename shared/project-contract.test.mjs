import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT_BODY_LIMIT, publicProjectBody, publicProjectOperation } from "./project-contract.mjs";
import { jsonBusinessCommand, jsonBusinessBodyLimit, publicJsonBusinessResult } from "./json-business-contract.mjs";
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
test("project commands keep a separate execution ACK and enough byte room for valid raster icons", () => {
  assert.equal(jsonBusinessCommand("projects", "PATCH"), true); assert.equal(jsonBusinessBodyLimit("projects"), PROJECT_BODY_LIMIT); assert.ok(PROJECT_BODY_LIMIT > 3000000);
  assert.deepEqual(publicProjectOperation({ id, execution: "unknown", input: "PRIVATE" }), { id, execution: "unknown" }); assert.equal(publicProjectOperation({ id: "bad", execution: "complete" }), null);
});
test("deep Project metadata projection preserves nullable/legacy fields and drops private owner data", () => {
  const project = { id: "p", name: "Project", rootPath: "/fixture", favorite: false, archived: false, createdAt: "now", lastOpenedAt: null, icon: null, iconColor: "purple", credentials: "PRIVATE", session: { token: "PRIVATE" } };
  const projected = publicProjectBody({ projects: [project], token: "PRIVATE" }, 200); assert.ok(!JSON.stringify(projected).includes("PRIVATE")); assert.equal(projected.projects[0].lastOpenedAt, null);
  assert.deepEqual(publicProjectBody({ project: { id: "p", name: "Legacy", rootPath: "/fixture" } }, 200), { project: { id: "p", name: "Legacy", rootPath: "/fixture" } });
  assert.equal(publicProjectBody({ project: { ...project, archived: "yes" } }, 200), null);
});
test("migration cleanup warnings and unknown operation outcomes do not claim an atomic save", () => {
  const outcome = publicProjectBody({ project: { id: "p", name: "Project", rootPath: "/moved" }, warning: "source cleanup pending", operation: { id, execution: "complete" }, mutation: { saved: true }, token: "PRIVATE" }, 200);
  assert.equal(outcome.warning, "source cleanup pending"); assert.equal(outcome.mutation, undefined); assert.ok(!JSON.stringify(outcome).includes("PRIVATE"));
  assert.deepEqual(publicProjectBody({ error: "failed", project: { token: "PRIVATE" }, operation: { id, execution: "unknown" } }, 503), { error: "failed", operation: { id, execution: "unknown" } });
  assert.deepEqual(publicJsonBusinessResult("projects", { status: 304, body: null, headers: { etag: "e", "set-cookie": "PRIVATE" } }), { status: 304, body: null, headers: { etag: "e" } });
});
