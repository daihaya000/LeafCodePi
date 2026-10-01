import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BACKEND_OWNER,
  IN_PROCESS_OWNER,
  readRuntimeOwner,
  runtimeOwnerPath,
  writeRuntimeOwner,
} from "./runtime-owner-state.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-runtime-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the cutover's decision survives a restart", (t) => {
  const dir = fixture(t);
  // Nothing recorded yet: the WebUI owns the runtime, as before the cutover.
  assert.equal(readRuntimeOwner(dir), IN_PROCESS_OWNER);
  assert.equal(writeRuntimeOwner(dir, BACKEND_OWNER), true);
  assert.equal(readRuntimeOwner(dir), BACKEND_OWNER);
  const saved = JSON.parse(readFileSync(runtimeOwnerPath(dir), "utf8"));
  assert.equal(saved.owner, BACKEND_OWNER);
  assert.equal(typeof saved.updatedAt, "string");
  // A rollback records the owner again, so the next start does not look like a cutover state.
  assert.equal(writeRuntimeOwner(dir, IN_PROCESS_OWNER), true);
  assert.equal(readRuntimeOwner(dir), IN_PROCESS_OWNER);
});

test("missing, corrupt or unknown state means the WebUI owns the runtime", (t) => {
  const dir = fixture(t);
  writeFileSync(runtimeOwnerPath(dir), "{not json", "utf8");
  assert.equal(readRuntimeOwner(dir), IN_PROCESS_OWNER);
  writeFileSync(runtimeOwnerPath(dir), JSON.stringify({ owner: "something-else" }), "utf8");
  assert.equal(readRuntimeOwner(dir), IN_PROCESS_OWNER);
  writeFileSync(runtimeOwnerPath(dir), JSON.stringify(["backend"]), "utf8");
  assert.equal(readRuntimeOwner(dir), IN_PROCESS_OWNER);
});

test("an unwritable state is reported instead of thrown", (t) => {
  const dir = fixture(t);
  const failure = () => { throw new Error("read-only"); };
  assert.equal(writeRuntimeOwner(dir, BACKEND_OWNER, { writeFile: failure }), false);
  assert.equal(writeRuntimeOwner(dir, BACKEND_OWNER, { mkdir: failure }), false);
  // An unknown owner name is normalised, never stored as a third state.
  assert.equal(writeRuntimeOwner(dir, "whatever"), true);
  assert.equal(readRuntimeOwner(dir), IN_PROCESS_OWNER);
});
