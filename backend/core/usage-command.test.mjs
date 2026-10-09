import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageCommands } from "./usage-command.mjs";
function fixture(t) { const root = mkdtempSync(join(tmpdir(), "usage-command-")); t.after(() => rmSync(root, { recursive: true, force: true })); const path = join(root, "ledger.json"); return { root, path, create: () => createUsageCommands({ ledgerPath: () => path }) }; }
test("external consume checkpoints before execution, serializes duplicates and refuses replay after restart", async t => {
  const { path, create } = fixture(t); const commands = create(), operationId = randomUUID(); let calls = 0;
  const handler = async () => { calls++; assert.equal(JSON.parse(readFileSync(path, "utf8")).operations[0].execution, "unknown"); return Response.json({ ok: false, code: "nothing_to_reset", creditId: "credit" }); };
  const [first, duplicate] = await Promise.all([commands.run({ operationId, handler }), commands.run({ operationId, handler })]);
  assert.equal(first.status, 200); assert.equal((await first.json()).operation.execution, "complete"); assert.equal(duplicate.status, 409);
  assert.equal((await create().run({ operationId, handler })).status, 409); assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).operations, [{ id: operationId, execution: "complete" }]);
});
test("response failure is unknown, sanitized and not re-executed across restart", async t => {
  const { path, create } = fixture(t); const operationId = randomUUID(); let calls = 0;
  const handler = async () => { calls++; throw new Error("PRIVATE-KEY/COOKIE/PROVIDER-URL"); };
  const response = await create().run({ operationId, handler }); assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.operation.execution, "unknown"); assert.ok(!JSON.stringify(body).includes("PRIVATE"));
  assert.equal((await create().run({ operationId, handler })).status, 409); assert.equal(calls, 1); assert.ok(!readFileSync(path, "utf8").includes("PRIVATE"));
});
test("invalid admission and corrupt ledger never call the provider", async t => {
  const { root, path, create } = fixture(t); let calls = 0; const handler = async () => { calls++; return Response.json({ ok: true }); };
  assert.equal((await create().run({ operationId: "invalid", handler })).status, 400); assert.deepEqual(readdirSync(root), []);
  writeFileSync(path, "{"); const refused = await create().run({ operationId: randomUUID(), handler });
  assert.equal(refused.status, 503); assert.equal((await refused.json()).operation.execution, "not-started"); assert.equal(calls, 0);
});
test("Next cannot create the admission ledger or execute a provider command", async t => {
  const { root, create } = fixture(t); const before = process.env.LEAFCODE_PI_PROCESS_ROLE; process.env.LEAFCODE_PI_PROCESS_ROLE = "next";
  t.after(() => { if (before === undefined) delete process.env.LEAFCODE_PI_PROCESS_ROLE; else process.env.LEAFCODE_PI_PROCESS_ROLE = before; });
  await assert.rejects(create().run({ operationId: randomUUID(), handler: async () => { throw new Error("must not run"); } }), /owned by Backend/);
  assert.deepEqual(readdirSync(root), []);
});
