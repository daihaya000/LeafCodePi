import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createProviderAuthCommands } from "./provider-auth-command.mjs";
function fixture(t) { const root = mkdtempSync(join(tmpdir(), "leafcode-auth-ledger-")); t.after(() => rmSync(root, { recursive: true, force: true })); const path = join(root, "commands.json"); return { root, path, commands: createProviderAuthCommands({ ledgerPath: () => path }) }; }
test("auth admission is durable before execution, stores no input and refuses replay after owner restart", async t => {
  const f = fixture(t), id = randomUUID(); let count = 0;
  const result = await f.commands.run({ operationId: id, handler: async () => {
    count++; assert.equal(JSON.parse(readFileSync(f.path, "utf8")).operations[0].execution, "unknown"); return Response.json({ sessionId: "s" });
  } });
  assert.deepEqual((await result.json()).operation, { id, execution: "complete" });
  const restarted = createProviderAuthCommands({ ledgerPath: () => f.path });
  assert.equal((await restarted.run({ operationId: id, handler: async () => { count++; } })).status, 409); assert.equal(count, 1);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.path, "utf8")).operations[0]).sort(), ["execution", "id"]);
});
test("a previous admission interrupted before its result is never repeated", async t => {
  const f = fixture(t), id = randomUUID(); writeFileSync(f.path, JSON.stringify({ version: 1, operations: [{ id, execution: "unknown" }] }));
  const duplicate = await f.commands.run({ operationId: id, handler: async () => { throw Error("Must not run"); } });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).operation.execution, "unknown");
});
test("auth operations serialize their admission and acknowledgements, not background credential completion", async t => {
  const f = fixture(t); let release; const gate = new Promise(resolve => { release = resolve; }); const order = [];
  const first = f.commands.run({ operationId: randomUUID(), handler: async () => { order.push(1); await gate; return Response.json({ sessionId: "s" }); } });
  const second = f.commands.run({ operationId: randomUUID(), handler: async () => { order.push(2); return Response.json({ ok: true }); } });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, [1]); release(); await Promise.all([first, second]); assert.deepEqual(order, [1, 2]);
});
test("unknown SDK outcome remains unknown; ledger failure before admission does not execute", async t => {
  const f = fixture(t); const thrown = await f.commands.run({ operationId: randomUUID(), handler: async () => { throw Error("PRIVATE SDK secret"); } });
  const body = await thrown.json(); assert.equal(body.operation.execution, "unknown"); assert.ok(!JSON.stringify(body).includes("PRIVATE"));
  writeFileSync(join(f.root, "file"), "x"); const bad = createProviderAuthCommands({ ledgerPath: () => join(f.root, "file", "commands.json") });
  const denied = await bad.run({ operationId: randomUUID(), handler: async () => { throw Error("Must not run"); } });
  assert.equal((await denied.json()).operation.execution, "not-started");
});
