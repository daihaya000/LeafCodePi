import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConfigurationCommands, watchConfigurationPath, markConfigurationRecovery, markConfigurationExternalWrite } from "./configuration-command.mjs";
import { publicConfigurationMutation } from "../../shared/configuration-contract.mjs";

function fixture(t, apply) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-config-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "settings.json"), ledger = join(root, "command.json");
  writeFileSync(file, "before");
  const commands = createConfigurationCommands({ ledgerPath: () => ledger, apply });
  const run = (handler, operationId = randomUUID()) => commands.run({ route: "settings/test", method: "PUT", operationId, handler });
  const save = () => { watchConfigurationPath(file); writeFileSync(file, "after"); return Response.json({ value: "public" }); };
  return { root, file, ledger, commands, run, save };
}
test("definition-specific application shares the settings queue and does not replace the default application", async t => {
  const order = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => { order.push("settings-applied"); });
  const first = f.commands.run({ route: "agents-md", method: "PATCH", handler: f.save, apply: async () => { order.push("definition-apply"); await gate; return "deferred"; } });
  await new Promise(resolve => setImmediate(resolve));
  const second = f.run(() => { order.push("settings-save"); return f.save(); });
  assert.deepEqual(order, ["definition-apply"]); release();
  assert.equal((await (await first).json()).mutation.apply, "deferred"); await second;
  assert.deepEqual(order, ["definition-apply", "settings-save", "settings-applied"]);
});
test("save checkpoints revision before apply and survives a new owner instance", async (t) => {
  let ledger, seen;
  const f = fixture(t, async () => { seen = JSON.parse(readFileSync(ledger, "utf8")).operations.at(-1); });
  ledger = f.ledger;
  const response = await f.run(f.save), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.mutation.saved, true); assert.equal(body.mutation.apply, "applied");
  assert.equal(seen.revision, body.mutation.revision); assert.equal(seen.apply, "unknown");
  const restarted = createConfigurationCommands({ ledgerPath: () => f.ledger });
  assert.deepEqual(restarted.read(body.mutation.operationId), body.mutation);
  assert.deepEqual(restarted.read(), { revision: body.mutation.revision });
  assert.equal(readFileSync(f.file, "utf8"), "after");
});
test("successful save and failed apply returns 503 without hiding saved revision or leaking error", async (t) => {
  const f = fixture(t, async () => { throw new Error("secret-provider-token C:/private/path"); });
  const response = await f.run(f.save), body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.mutation.saved, true); assert.equal(body.mutation.apply, "failed");
  assert.equal(body.mutation.saveStatus, "complete");
  assert.ok(body.mutation.revision); assert.equal(readFileSync(f.file, "utf8"), "after");
  assert.ok(!JSON.stringify(body).includes("secret-provider"));
  assert.equal(f.commands.read(body.mutation.operationId).apply, "failed");
});
test("write before handler failure is a partial save", async (t) => {
  const f = fixture(t);
  const response = await f.run(() => { f.save(); throw new Error("secret"); });
  const body = await response.json();
  assert.equal(response.status, 500); assert.equal(body.mutation.saved, true); assert.equal(body.mutation.saveStatus, "partial"); assert.equal(body.mutation.apply, "failed");
});
test("validation rejection is not a save and never runs apply", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; });
  const response = await f.run(() => Response.json({ error: "invalid" }, { status: 400 }));
  const body = await response.json();
  assert.equal(body.mutation.saved, false); assert.equal(body.mutation.revision, null); assert.equal(calls, 0);
});
test("rollback distinguishes restored and required recovery", async (t) => {
  for (const recovery of ["restored", "required"]) {
    const f = fixture(t);
    const response = await f.run(() => {
      watchConfigurationPath(f.file); writeFileSync(f.file, recovery === "restored" ? "before" : "partial");
      markConfigurationRecovery(recovery); return Response.json({ error: "failed" }, { status: 500 });
    });
    const { mutation } = await response.json();
    assert.equal(mutation.recovery, recovery); assert.equal(mutation.saved, recovery === "required");
  }
});
test("SDK credentials acknowledged outside a filesystem observer are saved; ambiguous failure is unknown", async (t) => {
  for (const stage of ["started", "saved"]) {
    const f = fixture(t);
    const response = await f.run(() => { markConfigurationExternalWrite(stage); return Response.json({}, { status: 500 }); });
    const { mutation } = await response.json();
    assert.equal(mutation.saved, stage === "saved" ? true : null);
    assert.equal(mutation.apply, stage === "saved" ? "failed" : "unknown");
  }
});
test("live application may be deferred; replaying the same operation never repeats writes", async (t) => {
  let writes = 0;
  const f = fixture(t, async () => "deferred");
  const id = randomUUID(), action = () => { writes++; return f.save(); };
  const response = await f.run(action, id);
  assert.equal((await response.json()).mutation.apply, "deferred");
  const duplicate = await f.run(action, id);
  assert.equal(duplicate.status, 409); assert.equal(writes, 1);
});
test("ledger I/O failure is explicit, not false full success", async (t) => {
  const f = fixture(t);
  const blocked = createConfigurationCommands({ ledgerPath: () => join(f.file, "ledger.json") });
  const response = await blocked.run({ route: "settings/test", method: "PUT", handler: f.save });
  const { mutation } = await response.json();
  assert.equal(response.status, 503);
  assert.equal(mutation.saved, true); assert.equal(mutation.revision, null); assert.equal(mutation.apply, "unknown");
  assert.equal(readFileSync(f.file, "utf8"), "after");
});
test("public mutation DTO rejects inconsistent states and drops arbitrary secret properties", () => {
  const value = { operationId: randomUUID(), saved: true, saveStatus: "complete", revision: randomUUID(), apply: "failed", recovery: "none", token: "SECRET" };
  assert.ok(!JSON.stringify(publicConfigurationMutation(value)).includes("SECRET"));
  assert.equal(publicConfigurationMutation({ ...value, saved: false }), null);
});
