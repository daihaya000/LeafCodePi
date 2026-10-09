import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeAliases, runtimeExternals, assertBackendInputs } from "../../scripts/build-backend-runtime.mjs";
const ROOT = resolve("."), require = createRequire(join(ROOT, "backend/package.json")), { build } = require("esbuild"), token = "t".repeat(32);
test("real Provider SSE:125sec,large stream,cuts,slow socket,recovery,completion,restart,bounded history", { timeout: 210000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "lcp-provider-events-")), data = join(dir, "data"), agent = join(dir, "agent"), children = [], streams = [], samples = { backend: [], relay: [] };
  mkdirSync(data); mkdirSync(agent); let backend, relay, base, sid;
  const owner = join(ROOT, "backend/runtime/provider-login.fixture-" + process.pid + ".mjs"), client = join(dir, "relay.mjs"), entry = join(dir, "owner.ts");
  writeFileSync(entry, `export {openProviderLoginEvents} from ${JSON.stringify(join(ROOT, "backend/runtime-src/json-business/provider-auth-events.ts"))};\nexport {readProviderLoginStreamDiagnostics} from ${JSON.stringify(join(ROOT, "backend/runtime-src/json-business/provider-login-stream.ts"))};\nexport {getActiveProviderLogin} from ${JSON.stringify(join(ROOT, "backend/runtime-src/lib/pi/harness.ts"))};\nexport {ProviderLoginSession} from ${JSON.stringify(join(ROOT, "backend/runtime-src/lib/pi/auth-login.ts"))};\n`);
  t.after(async () => { await Promise.all(streams.map(close)); for (const c of children.reverse()) await stop(c); rmSync(owner, { force: true }); rmSync(dir, { recursive: true, force: true }); });
  const banner = { js: 'import {createRequire as __fixtureRequire} from "node:module"; const require=__fixtureRequire(' + JSON.stringify(join(ROOT, "backend/package.json")) + ');' };
  const built = await build({ bundle: true, platform: "node", format: "esm", logLevel: "silent", entryPoints: [entry], outfile: owner, alias: runtimeAliases(), external: runtimeExternals(), tsconfig: join(ROOT, "backend/tsconfig.runtime.json"), banner, metafile: true }); assertBackendInputs(built.metafile);
  await build({ bundle: true, platform: "node", format: "esm", logLevel: "silent", entryPoints: [join(ROOT, "web/src/lib/provider-auth-events-relay.ts")], outfile: client, alias: { "@": join(ROOT, "web/src"), "@shared": join(ROOT, "shared") }, tsconfig: join(ROOT, "web/tsconfig.json"), banner });
  const env = { ...process.env, NODE_ENV: "test", LEAFCODE_PI_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, APPDATA: join(dir, "appdata"), LEAFCODE_PI_DEFAULT_DIR: join(dir, "workspaces"), LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "", LEAFCODE_PI_WEBUI_AUTH: "", LEAFCODE_PI_BACKEND_RUNTIME: "" };
  async function launch(role, extra = {}) {
    const c = fork(join(ROOT, "backend/src/provider-login-stream-fixture.mjs"), [], { env: { ...env, ...extra, LEAFCODE_PI_PROCESS_ROLE: role === "backend" ? "backend" : "next", PROVIDER_FIXTURE_ROLE: role, PROVIDER_FIXTURE_BUNDLE: role === "backend" ? owner : client }, stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(c);
    let stderr = ""; c.stderr.on("data", b => stderr += b);
    return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(stderr || "fixture timeout")), 10000); c.on("message", m => { samples[role].push(m); if (m.type === "ready") { clearTimeout(timer); resolve({ child: c, port: m.port, sid: m.state.sid }); } }); c.on("exit", code => { clearTimeout(timer); if (code) reject(Error(stderr || "fixture died")); }); });
  }
  async function stop(c) { if (c.exitCode !== null || c.signalCode !== null) return; const exited = new Promise(r => c.once("exit", r)); c.disconnect?.(); await Promise.race([exited, delay(1000)]); if (c.exitCode === null && c.signalCode === null) { c.kill(); await exited; } }
  const latest = role => samples[role].at(-1)?.state;
  async function settled(n = 0) { for (let i = 0; i < 160; i++) { if (latest("backend")?.active === n && latest("relay")?.active === n && latest("backend").readers === n && latest("backend").subscriptions === n) return; await delay(25); } assert.fail(JSON.stringify({ owner: latest("backend"), relay: latest("relay") })); }
  async function open(selected = sid, headers = {}) {
    const c = new AbortController(), r = await fetch(base + "/api/providers/fixture/login/events?sessionId=" + selected, { signal: c.signal, headers }); assert.equal(r.status, 200); assert.equal(r.headers.has("x-leafcode-backend-protocol"), false); assert.equal(r.headers.has("set-cookie"), false);
    const s = { c, reader: r.body.getReader(), bytes: 0, text: "", pings: 0, error: null, stopped: false };
    s.work = (async () => { try { for (;;) { const v = await s.reader.read(); if (v.done) break; s.bytes += v.value.length; const text = new TextDecoder().decode(v.value); s.pings += (text.match(/: ping/g) ?? []).length; s.text = (s.text + text).slice(-256000); } } catch (e) { if (!s.stopped) s.error = String(e); } })(); streams.push(s); return s;
  }
  async function text(s, needle) { for (let i = 0; i < 400; i++) { if (s.text.includes(needle)) return; await delay(10); } assert.fail(needle + ":" + s.text.slice(-500)); }
  async function close(s) { s.stopped = true; s.c.abort(); await s.reader.cancel().catch(() => {}); await s.work; }
  backend = await launch("backend"); sid = backend.sid; relay = await launch("relay", { LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:" + backend.port }); base = "http://127.0.0.1:" + relay.port;
  const first = await open(); await text(first, "fixture prompt"); await text(first, "callbackUrl"); await close(first); await settled(); assert.equal(latest("backend").loginAborted, false); assert.equal(latest("backend").pending, true);
  for (let i = 0; i < 32; i++) { const s = await open(); await text(s, "fixture prompt"); await close(s); } await settled();
  const one = await open(), two = await open(); await text(one, "fixture prompt"); await text(two, "fixture prompt"); await settled(2);
  const baseline = { backend: samples.backend.at(-1).memory, relay: samples.relay.at(-1).memory }, start = { backend: samples.backend.length, relay: samples.relay.length };
  backend.child.send({ type: "producer", interval: 5, bytes: 32700 }); const began = Date.now(); await delay(125000); const elapsed = Date.now() - began;
  t.diagnostic(JSON.stringify({ elapsed, bytes: [one.bytes, two.bytes], pings: [one.pings, two.pings], errors: [one.error, two.error], emitted: latest("backend").emitted, owner: latest("backend") }));
  assert.ok(one.bytes > 128 * 1024 * 1024); assert.ok(two.bytes > 128 * 1024 * 1024); assert.ok(one.pings >= 8 && two.pings >= 8); assert.equal(one.error, null); assert.equal(two.error, null);
  await close(one); await close(two); await settled(); const produced = latest("backend").emitted; await delay(100); assert.ok(latest("backend").emitted > produced); assert.equal(latest("backend").loginAborted, false); assert.ok(latest("backend").historyEntries <= 7); assert.ok(latest("backend").historyBytes < 512 * 1024);
  const slow = await new Promise((resolve, reject) => { const req = get(base + "/api/providers/fixture/login/events?sessionId=" + sid, res => { res.pause(); resolve({ req, res }); }); req.on("error", reject); }); await settled(1);
  backend.child.send({ type: "producer", interval: 1, bytes: 32700 }); for (let i = 0; i < 500 && latest("backend").active; i++) await delay(100); assert.equal(latest("backend").active, 0); slow.req.destroy(); slow.res.destroy(); await settled(); backend.child.send({ type: "producer", interval: 0 });
  const recovered = await open(sid, { "last-event-id": "old" }); await text(recovered, "fixture prompt"); await text(recovered, "callbackUrl"); await close(recovered); await settled();
  const completing = await open(); await text(completing, "fixture prompt"); backend.child.send({ type: "complete" }); await text(completing, '"ok":true'); await completing.work; await settled(); assert.equal(latest("backend").answered, true); assert.equal(latest("backend").loginAborted, false);
  const doneReplay = await open(); await doneReplay.work; assert.match(doneReplay.text, /event: done/); assert.ok(!doneReplay.text.includes("event: prompt")); assert.ok(!doneReplay.text.includes("isolated-fixture-code")); await settled();
  const metrics = { elapsed, bytes: one.bytes + two.bytes, disconnects: 32, owner: latest("backend"), relay: latest("relay"), peaks: {}, steadyHeap: {} };
  for (const role of ["backend", "relay"]) {
    const measured = samples[role].slice(start[role]); const d = Object.fromEntries(["rss", "heapUsed", "external"].map(k => [k, Math.max(...measured.map(s => s.memory[k])) - baseline[role][k]])); metrics.peaks[role] = d;
    assert.ok(d.rss < 128 * 1024 * 1024, role + " RSS " + JSON.stringify(d)); assert.ok(d.heapUsed < 48 * 1024 * 1024, role + " heap " + JSON.stringify(d)); assert.ok(d.external < 96 * 1024 * 1024, role + " buffers " + JSON.stringify(d));
    const early = Math.min(...measured.slice(200, 1200).map(s => s.memory.heapUsed)), late = Math.min(...measured.slice(-1000).map(s => s.memory.heapUsed)); metrics.steadyHeap[role] = late - early; assert.ok(late - early < 8 * 1024 * 1024, role + " growing retained heap " + (late - early));
  }
  for (const key of ["active", "subscriptions", "queuedBytes", "heartbeats", "stallTimers", "readers", "drainWaiters", "listeners"]) assert.equal(latest("backend")[key], 0, key);
  assert.ok(latest("backend").peakQueuedBytes <= 16 * 1024 * 1024); t.diagnostic(JSON.stringify(metrics));
  const oldSid = sid; await stop(relay.child); await stop(backend.child); backend = await launch("backend", { PROVIDER_FIXTURE_EMPTY: "1" }); relay = await launch("relay", { LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:" + backend.port }); base = "http://127.0.0.1:" + relay.port;
  const stale = await open(oldSid); await stale.work; assert.match(stale.text, /"ok":false/); assert.ok(!stale.text.includes("fixture prompt")); await settled();
  await stop(relay.child); await stop(backend.child); backend = await launch("backend"); sid = backend.sid; assert.notEqual(sid, oldSid); relay = await launch("relay", { LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:" + backend.port }); base = "http://127.0.0.1:" + relay.port;
  const fresh = await open(); await text(fresh, "fixture prompt"); await close(fresh); await settled();
});
