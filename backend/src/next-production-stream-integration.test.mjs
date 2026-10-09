import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, writeSync, closeSync, createReadStream, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { buildStreamProductionApp, PRODUCTION_STREAM_ROUTES } from "./stream-production-test-support.mjs";
import { TaskLeaseService } from "../core/task-runtime-lease.mjs";
import { runtimeAliases, runtimeExternals, assertBackendInputs } from "../../scripts/build-backend-runtime.mjs";
const ROOT = resolve("."), require = createRequire(join(ROOT, "backend/package.json")), { build } = require("esbuild"), MIB = 1024 * 1024;
const id = "11111111-1111-4111-8111-111111111111", token = "t".repeat(32);
test("actual Next production adapter:256MiB cold branch,512MiB files,125sec SSE,cancel,Range,HEAD,reconnect/restart", { timeout: 300000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "lcp-next-production-stream-")), app = join(dir, "next"), data = join(dir, "data"), agent = join(dir, "agent"), session = join(dir, "s.jsonl"), media = join(dir, "large.wav"), children = [], streams = [], samples = { backend: [], next: [] };
  for (const path of [app, data, agent]) mkdirSync(path); let backend, next, base, phase = "build";
  const owner = join(ROOT, "backend/runtime/cold-production.fixture-" + process.pid + ".mjs"), entry = join(dir, "owner.ts");
  t.after(async () => { await Promise.all(streams.map(close)); for (const c of children.reverse()) await stop(c); rmSync(owner, { force: true }); rmSync(dir, { recursive: true, force: true }); });
  let fd = openSync(session, "w"), parentId = null, length = 0;
  const rowId = i => "u" + String(i).padStart(32,"0");
  const persist = e => { const text = JSON.stringify(e) + "\n"; writeSync(fd, text); length += Buffer.byteLength(text); };
  persist({ type: "session", version: 3, id: "s", cwd: dir });
  for (let i = 0; i < 4400; i++) { persist({ type: "message", id: rowId(i), parentId, message: { role: "user", timestamp: i, content: [{ type: "text", text: "x".repeat(i < 4100 ? 65536 : 200) }] } }); parentId = rowId(i); }
  // The final current branch excludes a large sibling subtree without SDK hydration.
  persist({ type: "message", id: "sibling", parentId: rowId(4000), message: { role: "user", timestamp: 5000, content: [{ type: "text", text: "unselected branch" }] } });
  persist({ type: "message", id: "tip", parentId, message: { role: "user", timestamp: 6000, content: [{ type: "text", text: "persistent cold tip" }] } }); closeSync(fd); assert.ok(length > 256 * MIB);
  const digest = async () => { const hash = createHash("sha256"); for await (const part of createReadStream(session)) hash.update(part); return hash.digest("hex"); }, before = await digest();
  fd = openSync(media, "w"); const chunk = Buffer.alloc(65536, 73); Buffer.from("RIFF").copy(chunk); Buffer.from("WAVE").copy(chunk, 8); writeSync(fd, chunk); chunk.fill(73); for (let i = 1; i < 2048; i++) writeSync(fd, chunk); closeSync(fd);
  const stamp = "2026-01-01T00:00:00.000Z", task = { id: "task", kind: "code", status: "idle", directory: dir, title: "fixture", sessionFile: session, sessionId: "s", createdAt: stamp, updatedAt: stamp };
  writeFileSync(join(data, "store.json"), JSON.stringify({ version: 1, projects: [], tasks: [task, { ...task, id: "bot:" + id, kind: "bot", botId: id }] }));
  writeFileSync(join(data, "bots.json"), JSON.stringify({ version: 1, bots: [{ id, name: "fixture", directory: dir, sessionFile: session, sessionId: "s", createdAt: stamp, updatedAt: stamp }] }));
  const foreign = new TaskLeaseService({ dataDir: () => data, listTasks: () => [task], patchTask: () => task });
  assert.ok(foreign.acquireTaskLease("task")); t.after(() => foreign.releaseTaskLease("task"));
  writeFileSync(entry, ["export {openLiveEvents,readLiveEventDiagnostics} from " + JSON.stringify(join(ROOT, "backend/runtime-src/event-stream/index.ts")), "export {openTaskFileStream,readTaskFileStreamDiagnostics} from " + JSON.stringify(join(ROOT, "backend/runtime-src/file-stream/task-files.ts")), "export {readColdSnapshotDiagnostics} from " + JSON.stringify(join(ROOT, "backend/runtime-src/event-stream/cold-snapshot.ts"))].join(";\n"));
  const bundle = await build({ bundle: true, platform: "node", format: "esm", logLevel: "silent", entryPoints: [entry], outfile: owner, alias: runtimeAliases(), external: runtimeExternals(), tsconfig: join(ROOT, "backend/tsconfig.runtime.json"), banner: { js: 'import{createRequire as _require}from"node:module";const require=_require(' + JSON.stringify(join(ROOT, "backend/package.json")) + ');' }, metafile: true }); assertBackendInputs(bundle.metafile);
  const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", LEAFCODE_PI_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, APPDATA: join(dir, "appdata"), LEAFCODE_PI_DEFAULT_DIR: join(dir, "workspaces"), LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "", LEAFCODE_PI_WEBUI_AUTH: "", LEAFCODE_PI_BACKEND_RUNTIME: "" };
  const routes=PRODUCTION_STREAM_ROUTES, built=await buildStreamProductionApp(app,env,children);
  t.diagnostic("actual Next production build: "+built.routes+" unchanged API routes / "+built.modules+" source modules");
  async function launch(role, extra = {}) {
    const c = fork(join(ROOT, "backend/src/next-production-stream-fixture.mjs"), [], { env: { ...env, ...extra, LEAFCODE_PI_PROCESS_ROLE: role === "backend" ? "backend" : "next", STREAM_PRODUCTION_ROLE: role, STREAM_PRODUCTION_BUNDLE: owner, STREAM_NEXT_PACKAGE: join(ROOT, "web/package.json"), STREAM_NEXT_APP: app }, stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(c); let output = ""; for (const s of [c.stdout, c.stderr]) s.on("data", b => output = (output + b).slice(-20000));
    return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(output || "fixture startup timeout")), 15000); c.on("message", m => { samples[role].push({ ...m, phase }); if (m.type === "ready") { clearTimeout(timer); resolve({ child: c, port: m.port }); } }); c.once("exit", code => { clearTimeout(timer); if (code) reject(Error(output)); }); });
  }
  async function stop(c) { if (c.exitCode !== null || c.signalCode !== null) return; const exited = new Promise(r => c.once("exit", r)); c.disconnect?.(); await Promise.race([exited, delay(1000)]); if (c.exitCode === null && c.signalCode === null) { c.kill(); await exited; } }
  const latest = role => samples[role].at(-1)?.state;
  async function settled(n = 0) { for (let i = 0; i < 200; i++) { const s = latest("backend"); if (s?.live.active === n && s.file.active === 0 && s.file.descriptors === 0 && s.cold.coldReaders === 0 && s.cold.coldWaiters === 0 && s.cold.coldDescriptors === 0 && latest("next")?.active === n) return; await delay(25); } assert.fail(JSON.stringify({ owner: latest("backend"), next: latest("next") })); }
  async function open(path = "tasks/task/events", headers = {}) {
    const c = new AbortController(), r = await fetch(base + "/api/" + path, { signal: c.signal, headers }); assert.equal(r.status, 200); assert.equal(r.headers.has("x-leafcode-backend-protocol"), false);
    const s = { c, reader: r.body.getReader(), bytes: 0, text: "", pings: 0, error: null, stopped: false }; const decoder = new TextDecoder(); streams.push(s);
    s.done = (async () => { try { for (;;) { const part = await s.reader.read(); if (part.done) break; s.bytes += part.value.length; const text = decoder.decode(part.value, { stream: true }); s.pings += (text.match(/: ping/g) || []).length; s.text = (s.text + text).slice(-128000); } } catch (e) { if (!s.stopped) s.error = String(e); } })(); return s;
  }
  async function close(s) { s.stopped = true; s.c.abort(); await s.reader.cancel().catch(() => {}); await s.done; }
  async function text(s, needle) { for (let i = 0; i < 400; i++) { if (s.text.includes(needle)) return; await delay(25); } assert.fail(needle + ":" + s.text.slice(-1000)); }
  backend = await launch("backend"); next = await launch("next", { LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:" + backend.port }); base = "http://127.0.0.1:" + next.port;
  await settled(); const baseline = { backend: samples.backend.at(-1).memory, next: samples.next.at(-1).memory }, start = { backend: samples.backend.length, next: samples.next.length };
  phase = "cold-first"; const first = await open(); await text(first, '"eventType":"ready"'); await text(first, "persistent cold tip"); assert.match(first.text, /"hasMore":true/); assert.ok(!first.text.includes("unselected branch")); await close(first); await settled(); let scan = latest("backend").cold.coldScanBytes; assert.ok(scan > 256 * MIB);
  // Invalidate only fixture timestamps, then cut while the uncached scan is active.
  phase = "cold-cuts"; for (let i = 0; i < 8; i++) {
    const stamp = new Date(Date.now() + 2000 * (i + 1)); utimesSync(session, stamp, stamp);
    const c = new AbortController(), r = await fetch(base + "/api/tasks/task/events", { signal: c.signal }), reader = r.body.getReader(); await reader.read();
    for (let n = 0; n < 200 && (!latest("backend").cold.coldReaders || latest("backend").cold.coldScanBytes <= scan); n++) await delay(5);
    assert.equal(latest("backend").cold.coldReaders, 1); assert.ok(latest("backend").cold.coldScanBytes > scan); c.abort(); await reader.cancel().catch(() => {}); await settled(); scan = latest("backend").cold.coldScanBytes;
  }
  phase = "cold-refreshed"; const refreshed = await open(); await text(refreshed, "persistent cold tip"); await close(refreshed); await settled(); scan = latest("backend").cold.coldScanBytes;
  phase = "files"; const mediaUrl = base + "/api/tasks/task/media?path=" + encodeURIComponent(media);
  const head = await fetch(mediaUrl, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(128 * MIB)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(mediaUrl, { headers: { range: "bytes=8-11" } }); assert.equal(range.status, 206); assert.equal(await range.text(), "WAVE"); assert.equal(range.headers.get("content-range"), "bytes 8-11/" + 128 * MIB);
  assert.equal((await fetch(mediaUrl, { headers: { range: "bytes=" + 128 * MIB + "-" } })).status, 416);
  let fileBytes = 0; for (let i = 0; i < 4; i++) { const r = await fetch(mediaUrl); assert.equal(r.status, 200); for await (const part of r.body) fileBytes += part.length; } assert.equal(fileBytes, 512 * MIB); await settled();
  phase = "sse-cuts"; for (let i = 0; i < 32; i++) { const s = await open(i % 2 ? "bots/" + id + "/events" : undefined); await text(s, '"eventType":"ready"'); await close(s); } await settled(); assert.equal(latest("backend").cold.coldScanBytes, scan);
  phase = "file-cuts"; for (let i = 0; i < 16; i++) { const c = new AbortController(), r = await fetch(mediaUrl, { signal: c.signal }); await r.body.getReader().read(); c.abort(); } await settled();
  phase = "long-sse"; const one = await open(), two = await open("bots/" + id + "/events"); await text(one, "persistent cold tip"); await text(two, "persistent cold tip"); await settled(2);
  backend.child.send({ type: "producer", interval: 5, bytes: 32700 }); const began = Date.now(); await delay(125000); const elapsed = Date.now() - began;
  assert.ok(one.bytes > 128 * MIB && two.bytes > 128 * MIB); assert.ok(one.pings >= 8 && two.pings >= 8); assert.equal(one.error, null); assert.equal(two.error, null); await close(one); await close(two); await settled();
  phase = "paused"; const slow = await new Promise((resolve, reject) => { const req = get(base + "/api/tasks/task/events", res => { res.pause(); resolve({ req, res }); }); req.on("error", reject); }); await settled(1); backend.child.send({ type: "producer", interval: 1, bytes: 65536 });
  for (let i = 0; i < 500 && latest("backend").live.active; i++) await delay(100); assert.equal(latest("backend").live.active, 0); slow.req.destroy(); slow.res.destroy(); await settled(); backend.child.send({ type: "producer", interval: 0 });
  phase = "reconnect"; const restored = await open(undefined, { "last-event-id": "stale" }); await text(restored, "persistent cold tip"); await close(restored); await settled(); assert.equal(await digest(), before);
  const metrics = { elapsed, sourceBytes: length, fileBytes, sseBytes: one.bytes + two.bytes, sseCuts: 32, coldScanCuts: 8, foreignLeasePoll: true, fileCuts: 16, nextRoutes: routes.length, owner: latest("backend"), next: latest("next"), baseline, peaks: {}, steadyHeap: {}, heapPeakPhase: {} };
  for (const role of ["backend", "next"]) { const measured = samples[role].slice(start[role]), d = Object.fromEntries(["rss", "heapUsed", "external"].map(k => [k, Math.max(...measured.map(s => s.memory[k])) - baseline[role][k]])); metrics.peaks[role] = d; const peak = measured.reduce((a,b)=>a.memory.heapUsed>b.memory.heapUsed?a:b); metrics.heapPeakPhase[role]={phase:peak.phase,memory:peak.memory,spaces:peak.spaces,sdkLoaded:peak.state.sdkLoaded,state:peak.state}; const early = Math.min(...measured.slice(200,1200).map(s=>s.memory.heapUsed)), late = Math.min(...measured.slice(-1000).map(s=>s.memory.heapUsed)); metrics.steadyHeap[role] = late - early; }
  t.diagnostic(JSON.stringify(metrics));
  for (const role of ["backend","next"]) { const d=metrics.peaks[role]; assert.ok(d.rss<128*MIB,role+" RSS "+JSON.stringify(d)); assert.ok(d.heapUsed<48*MIB,role+" heap "+JSON.stringify(d)); assert.ok(d.external<96*MIB,role+" buffers "+JSON.stringify(d)); assert.ok(metrics.steadyHeap[role]<8*MIB,role+" growing retained heap"); }
  assert.equal(latest("backend").sdkLoaded,false);
  for (const key of ["individualSubscriptions", "individualReads", "individualWaiters", "individualPendingBytes", "individualPollTimers", "writers", "queuedBytes", "heartbeats", "stallTimers"]) assert.equal(latest("backend").live[key], 0, key); assert.equal(latest("backend").taskListeners, 0); assert.equal(latest("backend").botListeners, 0);
  await stop(next.child); await stop(backend.child); backend = await launch("backend"); next = await launch("next", { LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:" + backend.port }); base = "http://127.0.0.1:" + next.port;
  const restart = await open(); await text(restart, "persistent cold tip"); await close(restart); const botRestart = await open("bots/" + id + "/events"); await text(botRestart, "persistent cold tip"); await close(botRestart); await settled(); assert.equal(await digest(), before);
});
