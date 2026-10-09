import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createLlamaWebUiControl } from "./llama-webui-control.js";
import { createLlamaControlServer, listenControlServer, closeControlServer } from "./llama-control-server.js";
import { HOST_LLAMA_HEADER, HOST_LLAMA_OPERATION_HEADER } from "../../shared/host-llama-contract.mjs";
import { DEFAULT_LLAMA_SERVER_SETTINGS } from "../../shared/llama-server-settings.mjs";
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-host-llama-")); const original = process.env.LEAFCODE_PI_PROCESS_ROLE; process.env.LEAFCODE_PI_PROCESS_ROLE = "host";
  t.after(() => { rmSync(root, { recursive: true, force: true }); if (original === undefined) delete process.env.LEAFCODE_PI_PROCESS_ROLE; else process.env.LEAFCODE_PI_PROCESS_ROLE = original; });
  const calls = [], service = { status: async () => ({ running: false, pid: null, port: 8081, health: null, listeningPids: [], secret: "PRIVATE" }), start: async config => { calls.push(["start", config]); return { ok: true, pid: 1, secret: "PRIVATE" }; }, stop: async () => { calls.push(["stop"]); return { ok: true }; } };
  const create = () => createLlamaWebUiControl({ repoRoot: root, dataDir: root, service, ...extra }); const owner = create();
  const handle = (action, value, operationId = randomUUID()) => owner.handle({ action, body: value === undefined ? undefined : Buffer.from(JSON.stringify(value)), operationId, url: "/" });
  return { root, calls, create, owner, handle };
}
test("Host validates user start shape, maps platform binary, accepts supported spec, notifies Backend and durably refuses replay", async t => {
  let notifications = 0; const { root, calls, create, handle } = fixture(t, { notifyChanged: async () => { notifications++; } }), id = randomUUID();
  const result = await handle("start", { effort: "", contextLength: 8192, parallel: 2, llamaCppPath: "C:/tools/llama", specType: "draft-mtp,ngram-mod" }, id);
  assert.equal(result.status, 200); assert.equal(result.body.operation.execution, "complete"); assert.equal(calls.length, 1); assert.equal(calls[0][1].effort, ""); assert.equal(calls[0][1].specType, "draft-mtp,ngram-mod"); assert.equal(notifications, 1);
  assert.equal((await create().handle({ action: "start", body: Buffer.from("{}"), operationId: id, url: "/" })).status, 409); assert.equal(calls.length, 1);
  assert.ok(!readFileSync(join(root, "host-llama-command.json"), "utf8").includes("C:/tools/llama")); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});
test("Next is refused before Host service or filesystem effects", async t => {
  const { owner, calls } = fixture(t); process.env.LEAFCODE_PI_PROCESS_ROLE = "next";
  for (const action of ["status", "models", "start", "ensure-loaded"]) await assert.rejects(owner.handle({ action, url: "/", operationId: randomUUID(), body: Buffer.from("{}") }), /owned by Backend/);
  assert.equal(calls.length, 0);
});
test("invalid paths/effort/model/JSON reject before lifecycle effects and command admission", async t => {
  const { handle, calls, owner } = fixture(t);
  for (const body of [{ effort: "bad" }, { parallel: 17 }, { llamaCppPath: 'C:/bad"cmd' }, { modelFile: "../bad.gguf" }, { modelFile: "one.gguf" }, null, []]) assert.equal((await handle("start", body)).status, 400);
  assert.equal((await owner.handle({ action: "start", body: Buffer.from("{bad"), operationId: randomUUID() })).status, 400); assert.equal(calls.length, 0);
});
test("uncertain lifecycle results remain unknown and same ID cannot execute again", async t => {
  const f = fixture(t, { service: { start: async () => { f.calls.push("accepted"); throw Error("PRIVATE"); } } }), id = randomUUID();
  const first = await f.handle("start", {}, id); assert.equal(first.status, 503); assert.equal(first.body.operation.execution, "unknown");
  assert.equal((await f.handle("start", {}, id)).status, 409); assert.equal(f.calls.length, 1); assert.ok(!JSON.stringify(first).includes("PRIVATE"));
});
test("Host selects the persisted model, does not repost an already-loading model and survives repeat HTTP admissions", async t => {
  let posts = 0, catalog = 0;
  const { root, handle } = fixture(t, { waitMs: 0, fetch: async (_url, init) => { if (init?.method === "POST") { posts++; return Response.json({ ok: true }); } catalog++; return Response.json({ data: [{ id: "persisted", status: { value: "loading" } }] }); } });
  mkdirSync(join(root, "settings")); writeFileSync(join(root, "settings/llama-server-config.json"), JSON.stringify({ value: JSON.stringify({ ...DEFAULT_LLAMA_SERVER_SETTINGS, modelFile: "persisted.gguf" }) }));
  for (let i = 0; i < 2; i++) { const result = await handle("ensure-loaded", {}); assert.equal(result.status, 200); assert.equal(result.body.pending, true); assert.equal(result.body.modelId, "persisted"); }
  assert.equal(posts, 0); assert.equal(catalog, 2);
});
test("parallel load callers coalesce per server and only one models/load is issued", async t => {
  let posts = 0; const f = fixture(t, { waitMs: 0, fetch: async (_url, init) => { if (init?.method === "POST") { posts++; return Response.json({ ok: true }); } return Response.json({ data: [{ id: "a", status: { value: "unloaded" } }] }); } });
  const results = await Promise.all([f.handle("ensure-loaded", { preferredId: "a" }), f.handle("ensure-loaded", { preferredId: "other" })]); assert.ok(results.every(result => result.body.pending)); assert.equal(posts, 1);
});
test("model scans are Host-owned, cache scoped and bounded to configured roots; settings are read but never overwritten", async t => {
  const { root, owner } = fixture(t), models = join(root, "models"); mkdirSync(models); writeFileSync(join(models, "one.gguf"), "fixture");
  mkdirSync(join(root, "settings")); const path = join(root, "settings/llama-server-config.json"), saved = JSON.stringify({ value: JSON.stringify({ ...DEFAULT_LLAMA_SERVER_SETTINGS, modelDir: models }) }); writeFileSync(path, saved);
  const response = await owner.handle({ action: "models", url: "/?dir=" + encodeURIComponent(models) }); assert.equal(response.status, 200); assert.deepEqual(response.body.models, ["one.gguf"]); assert.equal(readFileSync(path, "utf8"), saved);
  assert.equal((await owner.handle({ action: "models", url: "/?dir=%2Fproc" })).status, 400);
});
async function serverFixture(t, handlers) {
  const probe = createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const server = createLlamaControlServer({ controlPort: port, ...handlers }); await listenControlServer(server, port); t.after(() => closeControlServer(server));
  return `http://127.0.0.1:${port}/webui/llama`;
}
test("private Host admission rejects Origin/marker/method/ID/bytes before owner and old Host is 501", async t => {
  let count = 0; const url = await serverFixture(t, { onLlamaWebUiControl: () => { count++; } });
  for (const [suffix, method, headers, body, status] of [["status", "GET", {}, undefined, 403], ["start", "POST", { [HOST_LLAMA_HEADER]: "1", origin: "http://localhost" }, "{}", 403], ["start", "GET", { [HOST_LLAMA_HEADER]: "1" }, undefined, 405], ["start", "POST", { [HOST_LLAMA_HEADER]: "1" }, "{}", 400], ["start", "POST", { [HOST_LLAMA_HEADER]: "1", [HOST_LLAMA_OPERATION_HEADER]: randomUUID() }, "x".repeat(65537), 413]]) {
    assert.equal((await fetch(url + "/" + suffix, { method, headers, ...(body === undefined ? {} : { body }) })).status, status);
  }
  assert.equal(count, 0); const old = await serverFixture(t, {}); assert.equal((await fetch(old + "/status", { headers: { [HOST_LLAMA_HEADER]: "1" } })).status, 501);
});
