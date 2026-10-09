import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskCollectionCommands } from "./task-collection-command.mjs";
function fixture(t) { const root = mkdtempSync(join(tmpdir(), "task-collection-command-")); t.after(() => rmSync(root, { recursive: true, force: true })); const path = join(root, "ledger.json"); return { root, path, create: () => createTaskCollectionCommands({ ledgerPath: () => path }) }; }
test("task collection checkpoints before execution, serializes duplicates and refuses replay after restart", async t => {
  const { path, create } = fixture(t); const commands = create(), operationId = randomUUID(); let calls = 0;
  const handler = async () => { calls++; assert.equal(JSON.parse(readFileSync(path, "utf8")).operations[0].execution, "unknown"); return Response.json({ ok: true }); };
  const [first, duplicate] = await Promise.all([commands.run({ operationId, handler }), commands.run({ operationId, handler })]);
  assert.equal(first.status, 200); assert.equal((await first.json()).operation.execution, "complete"); assert.equal(duplicate.status, 409);
  assert.equal((await create().run({ operationId, handler })).status, 409); assert.equal(calls, 1);
});
test("lost task collection result is unknown, sanitized and never re-executed", async t => {
  const { path, create } = fixture(t); const operationId = randomUUID(); let calls = 0;
  const handler = async () => { calls++; throw new Error("PRIVATE-PATH"); };
  const response = await create().run({ operationId, handler }); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.operation.execution, "unknown"); assert.ok(!JSON.stringify(body).includes("PRIVATE"));
  assert.equal((await create().run({ operationId, handler })).status, 409); assert.equal(calls, 1); assert.ok(!readFileSync(path, "utf8").includes("PRIVATE"));
});
test("invalid/corrupt admission never calls the task collection handler and Next cannot create the ledger", async t => {
  const { root, path, create } = fixture(t); let calls = 0; const handler = async () => { calls++; return Response.json({ ok: true }); };
  assert.equal((await create().run({ operationId: "bad", handler })).status, 400); assert.deepEqual(readdirSync(root), []);
  writeFileSync(path, "{"); assert.equal((await create().run({ operationId: randomUUID(), handler })).status, 503); assert.equal(calls, 0);
  const before = process.env.LEAFCODE_PI_PROCESS_ROLE; process.env.LEAFCODE_PI_PROCESS_ROLE = "next"; t.after(() => { if (before === undefined) delete process.env.LEAFCODE_PI_PROCESS_ROLE; else process.env.LEAFCODE_PI_PROCESS_ROLE = before; });
  const other = fixture(t); await assert.rejects(other.create().run({ operationId: randomUUID(), handler }), /owned by Backend/); assert.deepEqual(readdirSync(other.root), []);
});
