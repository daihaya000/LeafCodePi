import assert from "node:assert/strict";
import test from "node:test";
import { workspaceTarget, publicWorkspaceBody, WORKSPACE_BODY_LIMIT } from "./workspace-contract.mjs";
import { jsonBusinessTarget, jsonBusinessBodyLimit, jsonBusinessMutates, jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
test("workspace IDs decode once, routing does not misclassify a read-only POST as a write", () => {
  assert.deepEqual(workspaceTarget("projects/p%252Fone/files"), { route: "projects/[id]/files", params: { id: "p%2Fone" } });
  assert.equal(workspaceTarget("projects/%XX/files"), null); assert.equal(workspaceTarget("tasks/a/next-task"), null);
  assert.equal(jsonBusinessTarget("projects/p/next-task").route, "projects/[id]/next-task");
  assert.equal(jsonBusinessMutates("projects/p/next-task", "POST"), false); assert.equal(jsonBusinessCommand("projects/p/next-task", "POST"), false);
  assert.equal(jsonBusinessBodyLimit("projects/p/next-task"), WORKSPACE_BODY_LIMIT);
});
test("workspace listing preserves the raw client payload and deeply removes private owner fields", () => {
  const projected = publicWorkspaceBody("projects/[id]/files", { path: "src", parent: "", truncated: false, entries: [{ name: "a.ts", path: "src/a.ts", kind: "file", size: 1, token: "PRIVATE" }, { name: "nested", path: "src/nested", kind: "dir", auth: "PRIVATE" }], credential: "PRIVATE" }, 200);
  assert.deepEqual(projected, { path: "src", parent: "", truncated: false, entries: [{ name: "a.ts", path: "src/a.ts", kind: "file", size: 1 }, { name: "nested", path: "src/nested", kind: "dir" }] });
  assert.equal(publicWorkspaceBody("tasks/[id]/files", { ...projected, entries: [{ name: "a", path: "a", kind: "symlink" }] }, 200), null);
  assert.equal(publicWorkspaceBody("tasks/[id]/files", { ...projected, entries: Array(1001).fill({ name: "a", path: "a", kind: "file" }) }, 200), null);
});
test("file attachment is bounded base64 with matching byte size and no extra SDK/owner fields", () => {
  const file = { name: "a.txt", mimeType: "text/plain", size: 1, data: "YQ==", token: "PRIVATE" };
  assert.deepEqual(publicWorkspaceBody("tasks/[id]/files", file, 200), { name: "a.txt", mimeType: "text/plain", size: 1, data: "YQ==" });
  for (const invalid of [{ ...file, size: 2 }, { ...file, size: 65537 }, { ...file, data: "%%%" }, { ...file, mimeType: "image/png" }]) assert.equal(publicWorkspaceBody("tasks/[id]/files", invalid, 200), null);
});
test("suggestions expose only public model identity and error responses never retain stale data", () => {
  const input = { suggestion: "Add tests", suggestions: ["Add tests"], source: "direct", model: { providerID: "llama-server", modelID: "fixture", accountId: "a", apiKey: "PRIVATE", headers: { token: "PRIVATE" } }, prompt: "PRIVATE" };
  assert.deepEqual(publicWorkspaceBody("projects/[id]/next-task", input, 200), { suggestion: "Add tests", suggestions: ["Add tests"], source: "direct", model: { providerID: "llama-server", modelID: "fixture", accountId: "a" } });
  assert.deepEqual(publicWorkspaceBody("projects/[id]/next-task", { ...input, error: "unavailable" }, 503), { error: "unavailable" });
  assert.deepEqual(publicJsonBusinessResult("projects/p/files", { status: 200, headers: { "cache-control": "no-store", "set-cookie": "PRIVATE" }, body: { name: "a", mimeType: "text/plain", size: 1, data: "YQ==" } }).headers, { "cache-control": "no-store" });
});
