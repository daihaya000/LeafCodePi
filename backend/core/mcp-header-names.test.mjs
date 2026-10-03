import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackendMcpHeaderNameStore } from "./mcp-header-names.mjs";

const safe = (error) => error instanceof Error && error.message === "MCP header name store unavailable" && error.cause === undefined;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-header-names-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createBackendMcpHeaderNameStore({ dataDir: root }) };
}

test("construction is inert; a missing record reads as empty and never creates the file", async (t) => {
  const { root, store } = await fixture(t);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(store.read("remote"), []);
  assert.deepEqual(await readdir(root), []);
});

test("record/read/clear round-trip name-only data without values", async (t) => {
  const { root, store } = await fixture(t);
  assert.equal(store.record("remote", ["Authorization", "x-fixture"]), undefined);
  assert.deepEqual(store.read("remote"), ["Authorization", "x-fixture"]);
  assert.deepEqual(store.read("other"), []);
  store.record("remote", ["x-fixture", "x-fixture"]); // duplicates collapse
  assert.deepEqual(store.read("remote"), ["x-fixture"]);
  const text = await readFile(join(root, "mcp-header-names.json"), "utf8");
  assert.equal(text.includes("Bearer"), false);
  store.clear("remote");
  assert.deepEqual(store.read("remote"), []);
  assert.deepEqual(JSON.parse(await readFile(join(root, "mcp-header-names.json"), "utf8")).servers, {});
});

test("malformed records and inputs refuse without leaking paths or values", async (t) => {
  const { root, store } = await fixture(t);
  for (const body of ["{", "{}", '{"version":2,"servers":{}}', '{"version":1,"servers":{"a":"b"}}',
    '{"version":1,"servers":{"a":["bad name"]}}', '{"version":1,"servers":{"a":["x".repeat(300)]}}']) {
    await writeFile(join(root, "mcp-header-names.json"), body);
    assert.throws(() => store.read("a"), safe);
  }
  await rm(join(root, "mcp-header-names.json"), { force: true });
  for (const name of ["", "x".repeat(129), 1]) assert.throws(() => store.read(name), safe);
  assert.throws(() => store.record("remote", "Authorization"), safe);
  assert.throws(() => store.record("remote", ["bad name"]), safe);
  assert.throws(() => store.record("remote", Array.from({ length: 33 }, (_, index) => `x-${index}`)), safe);
  assert.throws(() => createBackendMcpHeaderNameStore({ dataDir: "relative" }), safe);
  assert.throws(() => createBackendMcpHeaderNameStore({ dataDir: root, extra: true }), safe);
  assert.throws(() => createBackendMcpHeaderNameStore({ dataDir: root, fileName: "a/b.json" }), safe);
});
