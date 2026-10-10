import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSpaGeneration } from "../../scripts/spa-build-generation.mjs";
import { gatewayLaunchPlan, launchProductionGateway } from "./gateway-launch.js";
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
async function pairs(t) {
  const root = mkdtempSync(join(tmpdir(), "gateway-admission-")), checkout = join(root, "source"), mirrorRoot = join(root, "mirror"); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["web", "shared", "scripts", "gateway/src", "docs/plans"]) mkdirSync(join(checkout, dir), { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) cpSync(join(ROOT, "gateway", name), join(checkout, "gateway", name));
  writeFileSync(join(checkout, "docs/plans/next-thin-phase0.json"), "{}");
  const compileBuild = async ({ stage }) => {
    for (const dir of ["spa/assets", "gateway/dist/gateway/src", "gateway/node_modules/undici"]) mkdirSync(join(stage, dir), { recursive: true });
    writeFileSync(join(stage, "spa/index.html"), '<html><script type="module" src="/assets/index-Abc123_-.js"></script></html>'); writeFileSync(join(stage, "spa/assets/index-Abc123_-.js"), "export {};");
    writeFileSync(join(stage, "gateway/dist/gateway/src/index.mjs"), "export {};"); writeFileSync(join(stage, "gateway/dist/manifest.json"), JSON.stringify({ routes: Array.from({ length: 165 }, () => ({})), operations: 265, sources: ["gateway/src/index.mjs"] })); writeFileSync(join(stage, "gateway/node_modules/undici/package.json"), '{"version":"8.10.2"}');
  };
  const first = await buildSpaGeneration({ checkout, mirrorRoot, compileBuild }), second = await buildSpaGeneration({ checkout, mirrorRoot, compileBuild }); return { checkout, mirrorRoot, first, second };
}
function child() { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.exitCode = null; c.signalCode = null; return c; }
test("launch plan pins validated production ingress and retains port/bind/auth/proxy/backend client environment", () => {
  const generation = { entry: "/sealed/gateway/index.mjs", cwd: "/sealed/gateway", staticRoot: "/sealed/spa" }, env = { LEAFCODE_PI_PORT: "3011", LEAFCODE_PI_BIND_HOST: "100.64.1.2", LEAFCODE_PI_WEBUI_AUTH: "required", LEAFCODE_PI_WEBUI_TOKEN: "dummy", LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:1", LEAFCODE_PI_BACKEND_GENERATION: "owner", NODE_ENV: "development", LEAFCODE_PI_SPA_DIR: "/wrong" };
  const plan = gatewayLaunchPlan(generation, env); assert.deepEqual(plan.args, [generation.entry]); assert.equal(plan.cwd, generation.cwd); assert.equal(plan.env.LEAFCODE_PI_SPA_DIR, generation.staticRoot); assert.equal(plan.env.NODE_ENV, "production"); assert.equal(plan.env.LEAFCODE_PI_BIND_HOST, env.LEAFCODE_PI_BIND_HOST); assert.equal(plan.env.LEAFCODE_PI_BACKEND_GENERATION, "owner"); assert.equal(plan.env.LEAFCODE_PI_WEBUI_TOKEN, "dummy");
  assert.throws(() => gatewayLaunchPlan(generation, { LEAFCODE_PI_MODE: "dev" }), /Controlled development/); assert.throws(() => gatewayLaunchPlan({}), /Verified/);
});
test("split native listen acknowledgement admits a child without asking Backend readiness", async t => {
  const f = await pairs(t), c = child(); const result = await launchProductionGateway({ ...f, env: {}, spawn: () => c, stop: () => assert.fail("must not stop"), pipe: () => setImmediate(() => { c.stdout.emit("data", '{"type":"gateway_'); c.stdout.emit("data", 'listening","port":3010}\n'); }) });
  assert.equal(result.process, c); assert.equal(result.generation.id, f.second.id); assert.equal(c.listenerCount("close"), 0); assert.equal(c.stdout.listenerCount("data"), 0);
});
test("early failed child is stopped before old-pair start; neither failed child consumes the Host crash watcher", async t => {
  const f = await pairs(t), events = [], made = [];
  const result = await launchProductionGateway({ ...f, env: {}, spawn: args => { const c = child(); made.push(c); events.push(args[0]); return c; }, stop: async c => { events.push("stopped"); c.exitCode = 1; }, pipe: c => setImmediate(() => { if (c === made[0]) c.emit("close", 1); else c.stdout.emit("data", '{"type":"gateway_listening","port":3010}\n'); }) });
  assert.deepEqual(events, [f.second.entry, "stopped", f.first.entry]); assert.equal(result.generation.id, f.first.id); assert.equal(result.fallback, true);
});
test("a failing log callback releases admission listeners before stopping and recovery", async t => {
  const f = await pairs(t), made = []; await assert.rejects(launchProductionGateway({ ...f, env: {}, spawn: () => { const c = child(); made.push(c); return c; }, pipe() { throw Error("log attachment"); }, stop: async c => { c.exitCode = 1; } }), /log attachment/);
  for (const c of made) { assert.equal(c.listenerCount("close"), 0); assert.equal(c.stdout.listenerCount("data"), 0); }
});
test("startup timeout and failed recovery fail explicitly and release every listener", async t => {
  const f = await pairs(t), made = []; await assert.rejects(launchProductionGateway({ ...f, env: {}, timeoutMs: 10, spawn: () => { const c = child(); made.push(c); return c; }, stop: async c => { c.exitCode = 1; } }), /deadline/);
  assert.equal(made.length, 2); for (const c of made) { assert.equal(c.listenerCount("close"), 0); assert.equal(c.stdout.listenerCount("data"), 0); }
});
