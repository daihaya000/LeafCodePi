import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireRuntimeOwner } from "./runtime-owner-lock.mjs";

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "leafcode-runtime-owner-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, ownerPath: join(dataDir, "runtime-owner.json") };
}
const options = (pid, key, extra = {}) => ({ pid, getProcessStartKey: () => key, ...extra });

test("claims one owner slot and releases only its own record", (t) => {
  const f = fixture(t);
  const release = acquireRuntimeOwner(f.dataDir, options(41001, "start-a", { kill: () => {} }));
  const owner = JSON.parse(readFileSync(f.ownerPath, "utf8"));
  assert.deepEqual({ pid: owner.pid, startKey: owner.startKey }, { pid: 41001, startKey: "start-a" });
  assert.throws(() => acquireRuntimeOwner(f.dataDir, options(41002, "start-b", { kill: () => {}, getProcessStartKey: (pid) => pid === 41001 ? "start-a" : "start-b" })), /already owned by PID 41001/);
  release();
  release();
  assert.equal(existsSync(f.ownerPath), false);
});

test("reclaims an owner whose PID is no longer alive", (t) => {
  const f = fixture(t);
  writeFileSync(f.ownerPath, JSON.stringify({ pid: 42001, startKey: "dead", token: "old" }));
  const release = acquireRuntimeOwner(f.dataDir, options(42002, "new", {
    kill: (pid) => { if (pid === 42001) throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  }));
  assert.equal(JSON.parse(readFileSync(f.ownerPath, "utf8")).pid, 42002);
  release();
});

test("reclaims a reused PID only when its process-start key differs", (t) => {
  const f = fixture(t);
  writeFileSync(f.ownerPath, JSON.stringify({ pid: 43001, startKey: "old-start", token: "old" }));
  const release = acquireRuntimeOwner(f.dataDir, options(43002, "new-start", {
    kill: () => {}, getProcessStartKey: (pid) => pid === 43001 ? "replacement-start" : "new-start",
  }));
  assert.equal(JSON.parse(readFileSync(f.ownerPath, "utf8")).pid, 43002);
  release();
});

test("fails closed when the existing owner PID is alive with the same start key", (t) => {
  const f = fixture(t);
  writeFileSync(f.ownerPath, JSON.stringify({ pid: 44001, startKey: "same", token: "owner" }));
  assert.throws(() => acquireRuntimeOwner(f.dataDir, options(44002, "other", {
    kill: () => {}, getProcessStartKey: (pid) => pid === 44001 ? "same" : "other",
  })), /already owned by PID 44001/);
  assert.equal(JSON.parse(readFileSync(f.ownerPath, "utf8")).token, "owner");
});

test("does not steal a freshly created malformed owner record", (t) => {
  const f = fixture(t);
  writeFileSync(f.ownerPath, "{");
  assert.throws(() => acquireRuntimeOwner(f.dataDir, options(45002, "new")), /still being written/);
});

test("an old malformed owner record is recoverable", (t) => {
  const f = fixture(t);
  writeFileSync(f.ownerPath, "{");
  const old = new Date(Date.now() - 3_000);
  utimesSync(f.ownerPath, old, old);
  const release = acquireRuntimeOwner(f.dataDir, options(46002, "new"));
  assert.equal(JSON.parse(readFileSync(f.ownerPath, "utf8")).pid, 46002);
  release();
});

test("an owner cannot release a replacement record", (t) => {
  const f = fixture(t);
  const release = acquireRuntimeOwner(f.dataDir, options(47001, "old"));
  writeFileSync(f.ownerPath, JSON.stringify({ pid: 47002, startKey: "new", token: "replacement" }));
  release();
  assert.equal(JSON.parse(readFileSync(f.ownerPath, "utf8")).token, "replacement");
});
