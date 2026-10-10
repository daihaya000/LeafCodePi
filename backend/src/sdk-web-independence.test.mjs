import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildSpaGeneration } from "../../scripts/spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(r => child.once("exit", r));
  child.kill();
  let timer;
  await Promise.race([exited, new Promise(r => { timer = setTimeout(r, 3000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(message);
}

test("real SDK/harness/lease keep running across production native gateway stop and restart without replay", { timeout: 240000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-sdk-web-independent-")), data = join(root, "data"), agent = join(root, "agent"), nextData = join(root, "no-next-data"), mirror = join(root, "web"), children = [], pending = new Map();
  const browsers = [];
  t.after(async () => {
    for (const b of browsers) b.abort();
    for (const c of [...children].reverse()) await stop(c);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("Fixture stopped")); }
    pending.clear();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(data); mkdirSync(agent);
  const backendCheckout = join(root, "backend-only");
  for (const folder of ["backend", "shared", "scripts", "extensions"]) cpSync(join(ROOT, folder), join(backendCheckout, folder), { recursive: true, filter: path => !/(?:^|[\\/])(?:node_modules|runtime|dist|\.git)(?:[\\/]|$)/.test(path) });
  const dependencies = join(backendCheckout, "backend/node_modules");
  symlinkSync(join(ROOT, "backend/node_modules"), dependencies, process.platform === "win32" ? "junction" : "dir");
  t.after(() => { if (existsSync(dependencies)) unlinkSync(dependencies); });
  assert.equal(existsSync(join(backendCheckout, "web")), false);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], promptTemplates: [], compaction: { enabled: false }, retry: { enabled: false } }));
  const env = { ...process.env, NODE_ENV: "test", NODE_OPTIONS: "", HOME: root, USERPROFILE: root,
    PI_CODING_AGENT_DIR: agent, APPDATA: join(root, "roaming"), LEAFCODE_PI_DATA_DIR: data, LEAFCODE_PI_DEFAULT_DIR: join(root, "workspaces"),
    LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_BACKEND_PORT: "0", LEAFCODE_PI_BACKEND_RUNTIME: "1", LEAFCODE_PI_MCP_NATIVE: "",
    LEAFCODE_PI_BACKEND_TOKEN: "isolated-sdk-" + randomUUID(), LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "",
    LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: join(backendCheckout, "backend/runtime/runtime.bundle.mjs"), LEAFCODE_PI_WEBUI_AUTH: "required", LEAFCODE_PI_WEBUI_TOKEN: "finite-browser",
    LEAFCODE_PI_PUSHOVER_TOKEN: "", LEAFCODE_PI_PUSHOVER_USER: "" };
  const compile = spawn(process.execPath, [join(backendCheckout, "scripts/build-backend-runtime.mjs")], { cwd: backendCheckout, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(compile);
  let compileLog = ""; for (const stream of [compile.stdout, compile.stderr]) stream.on("data", part => { compileLog += part; });
  assert.equal(await new Promise((resolve, reject) => { compile.once("error", reject); compile.once("exit", resolve); }), 0, compileLog);
  let backendOutput = "", backendError = "";
  const backend = spawn(process.execPath, [join(backendCheckout, "backend/src/sdk-web-independence-fixture.mjs")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }); children.push(backend);
  backend.stdout.on("data", b => backendOutput = (backendOutput + b).slice(-20000)); backend.stderr.on("data", b => backendError = (backendError + b).slice(-20000));
  backend.on("message", m => { const waiter = pending.get(m?.reply); if (waiter) { pending.delete(m.reply); clearTimeout(waiter.timer); m.error ? waiter.reject(new Error(m.error)) : waiter.resolve(m.value); } });
  function command(action, extra = {}) { return new Promise((resolveCommand, reject) => { const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error(`Backend IPC timeout: ${action}; ${backendError}`)); }, 15000); pending.set(id, { resolve: resolveCommand, reject, timer }); backend.send({ id, action, ...extra }); }); }
  const privateHeaders = { authorization: `Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`, "x-leafcode-backend-protocol": "1" };
  const backendBase = await until(async () => {
    assert.equal(backend.exitCode, null, backendError);
    for (const line of backendOutput.split(/\r?\n/)) { try { const m = JSON.parse(line); if (m.type === "backend_listening") return `http://127.0.0.1:${m.port}`; } catch {} }
  }, "Backend did not listen");
  const health = await until(async () => { const r = await fetch(backendBase + "/internal/health", { headers: privateHeaders, signal: AbortSignal.timeout(1500) }); const v = await r.json(); return v.ready && v; }, "Backend did not become ready: " + backendError);
  const generation = health.runtimeGeneration;
  assert.equal(generation, createHash("sha256").update(readFileSync(env.LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE)).digest("hex").slice(0, 16));
  let id, sdkIdentity;
  if (process.env.LEAFCODE_PI_SDK_PROBE_ONLY === "1") {
    const created = await command("create");
    id = created.task.id;
    assert.equal(created.realAgentSession, true); assert.equal(created.liveCount, 1);
    const active = await until(async () => { const s = await command("sample"); return s.activeGate === 1 && s; }, "SDK provider did not run"); assert.equal(active.realAgentSession, true); assert.equal(active.calls, 1); assert.equal(active.lease.pid, backend.pid);
    await command("release", { gate: 1 });
    let lastSample;
    try { await until(async () => { lastSample = await command("sample"); return !lastSample.streaming; }, "SDK probe did not finish"); }
    catch (error) { throw new Error(`${error}; ${JSON.stringify(lastSample)}; ${backendError}`); }
    t.diagnostic("real Backend entry/harness/SDK/session/lease, finite provider, no Web"); return;
  }
  const frontend = await buildSpaGeneration({ checkout: ROOT, mirrorRoot: mirror, offline: true });
  const traces = Object.keys(frontend.files).length;
  for (const path of Object.keys(frontend.files)) assert.doesNotMatch(path, /node_modules\/(?:next|@earendil)|^(?:backend|host|extensions)\//);
  const port = await freePort(), base = `http://127.0.0.1:${port}`, headers = { cookie: "leafcode-pi-token=finite-browser" };
  const webEnv = { ...env, NODE_ENV: "production", LEAFCODE_PI_PROCESS_ROLE: "next", LEAFCODE_PI_DATA_DIR: nextData, LEAFCODE_PI_BACKEND_URL: backendBase, LEAFCODE_PI_BACKEND_GENERATION: generation, LEAFCODE_PI_PORT: String(port), LEAFCODE_PI_BIND_HOST: "127.0.0.1", LEAFCODE_PI_SPA_DIR: frontend.staticRoot };
  function launch() { let output = ""; const c = spawn(process.execPath, [frontend.entry], { cwd: frontend.cwd, env: webEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(c); for (const stream of [c.stdout, c.stderr]) stream.on("data", part => { output = (output + part).slice(-20000); }); return { c, log: () => output }; }
  async function web() { const run = launch(); await until(async () => { assert.equal(run.c.exitCode, null, run.log()); try { return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "Native gateway did not start"); return run.c; }
  async function detail() { const r = await fetch(base + `/api/tasks/${id}`, { headers, signal: AbortSignal.timeout(3000) }); assert.equal(r.status, 200); return r.json(); }
  async function prompt(text) { const r = await fetch(base + `/api/tasks/${id}/prompt`, { method: "POST", headers: { ...headers, "content-type": "application/json", origin: base }, body: JSON.stringify({ prompt: text }), signal: AbortSignal.timeout(10000) }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); }
  async function identity() { const s = await command("sample"); assert.equal(s.pid, sdkIdentity.pid); assert.equal(s.sessionId, sdkIdentity.sessionId); assert.equal(s.realAgentSession, true); assert.equal(s.sameSession, true); assert.equal(s.liveCount, 1); assert.deepEqual(s.owner, sdkIdentity.owner); const h = await (await fetch(backendBase + "/internal/health", { headers: privateHeaders, signal: AbortSignal.timeout(1500) })).json(); assert.equal(h.runtimeGeneration, generation); assert.equal(h.ready, true); return s; }
  const createBody = { projectId: null, prompt: "第一: SDK生成中にWebを再起動", model: "finite-sdk::bounded", thinkingLevel: "off", permissionMode: "deny", subagentPermission: "deny" };
  async function duplicate(operation, creation = false) { const route = creation ? "tasks" : `tasks/${id}/prompt`; const r = await fetch(backendBase + `/internal/json-business/${route}`, { method: "POST", headers: { ...privateHeaders, "content-type": "application/json", "x-leafcode-business-authorized": "1", "x-leafcode-business-origin": base, "x-leafcode-business-host": `127.0.0.1:${port}`, "x-leafcode-business-operation": operation }, body: JSON.stringify(creation ? createBody : { prompt: "must never replay" }), signal: AbortSignal.timeout(3000) }); assert.equal(r.status, 200); const v = await r.json(); assert.equal(v.status, 409, JSON.stringify(v)); }
  let webChild = await web(); assert.equal((await fetch(base + "/api/tasks")).status, 401);
  const createResponse = await fetch(base + "/api/tasks", { method: "POST", headers: { ...headers, "content-type": "application/json", origin: base }, body: JSON.stringify(createBody), signal: AbortSignal.timeout(10000) });
  assert.equal(createResponse.status, 200, await createResponse.clone().text());
  const first = await createResponse.json(), operation1 = first.operation.id;
  id = first.task.id;
  const created = await command("track", { taskId: id });
  assert.equal(created.realAgentSession, true); assert.equal(created.liveCount, 1);
  sdkIdentity = { pid: backend.pid, sessionId: created.sessionId, owner: created.owner }; assert.ok(sdkIdentity.sessionId);
  assert.equal(created.owner.pid, backend.pid);
  const before = await until(async () => { const s = await identity(); return s.activeGate === 1 && s; }, "First SDK generation did not begin"); assert.equal(before.calls, 1); assert.equal(before.streaming, true); assert.equal(before.lease.pid, backend.pid);
  const browser = new AbortController(); browsers.push(browser);
  const events = await fetch(base + `/api/tasks/${id}/events`, { headers, signal: browser.signal }); assert.equal(events.status, 200); const reader = events.body.getReader(); await reader.read();
  await stop(webChild); browser.abort(); await reader.cancel().catch(() => {});
  // At least one real 15s lease heartbeat occurs with no Next process or browser reader.
  await delay(16000); const absent = await identity(); assert.equal(absent.streaming, true); assert.equal(absent.calls, 1); assert.equal(absent.lease.token, before.lease.token); assert.equal(absent.lease.acquiredAt, before.lease.acquiredAt); assert.ok(absent.lease.heartbeatAt > before.lease.heartbeatAt);
  webChild = await web(); const reopened = await detail(); assert.ok(JSON.stringify(reopened).includes("第一: SDK生成中にWebを再起動")); await duplicate(operation1, true);
  const reconnect = new AbortController(); browsers.push(reconnect);
  const reconnectedEvents = await fetch(base + `/api/tasks/${id}/events`, { headers, signal: reconnect.signal });
  assert.equal(reconnectedEvents.status, 200);
  const reconnectReader = reconnectedEvents.body.getReader();
  const resultEvent = (async () => {
    let text = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reconnectReader.read();
      assert.equal(done, false, "Reconnected SDK stream ended before its result");
      text += decoder.decode(value, { stream: true });
      assert.ok(text.length <= 512 * 1024, "Finite SDK stream exceeded fixture limit");
      if (text.includes("SDK第一結果")) return;
    }
  })();
  const streamTimeout = setTimeout(() => reconnect.abort(), 10000);
  resultEvent.catch(() => {}); // Cleanup can abort this reader after an earlier IPC failure.
  try { await command("release", { gate: 1 }); await resultEvent; } finally { clearTimeout(streamTimeout); reconnect.abort(); await reconnectReader.cancel().catch(() => {}); }
  await until(async () => { const s = await identity(); return !s.streaming && s.status !== "working"; }, "First SDK generation did not settle");
  const firstResult = JSON.stringify(await detail()); assert.ok(firstResult.includes("SDK第一結果")); assert.ok(!firstResult.includes(env.LEAFCODE_PI_BACKEND_TOKEN));
  const second = await prompt("第二: Web停止中にSDKを完了"), operation2 = second.operation.id;
  await until(async () => (await identity()).activeGate === 2, "Second SDK generation did not begin"); await stop(webChild); await command("release", { gate: 2 });
  const completedWithoutWeb = await until(async () => { const s = await identity(); return !s.streaming && s.status !== "working" && s; }, "SDK did not finish without Next"); assert.equal(completedWithoutWeb.calls, 2);
  webChild = await web(); const final = JSON.stringify(await detail()); assert.ok(final.includes("SDK第一結果")); assert.ok(final.includes("SDK第二結果")); await duplicate(operation1, true); await duplicate(operation2);
  const end = await identity(); assert.equal(end.calls, 2); assert.equal(end.networkDisabled, true); assert.equal(existsSync(nextData), false);
  const persisted = readFileSync(join(data, "store.json"), "utf8"), stored = JSON.parse(persisted).tasks.find(t => t.id === id);
  assert.equal(stored.sessionId, sdkIdentity.sessionId); const entries = readFileSync(stored.sessionFile, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(entries[0].type, "session"); assert.equal(entries[0].id, sdkIdentity.sessionId);
  for (const text of ["SDK第一結果", "SDK第二結果"]) assert.equal(entries.filter(e => e.type === "message" && e.message?.role === "assistant" && e.message.stopReason === "stop" && JSON.stringify(e.message).includes(text)).length, 1);
  for (const [filename, operation] of [["task-collection-command.json", operation1], ["task-conversation-command.json", operation2]]) {
    const ledger = readFileSync(join(data, filename), "utf8"), receipts = JSON.parse(ledger).operations;
    assert.equal(receipts.length, 1); assert.equal(receipts[0].id, operation); assert.equal(receipts[0].execution, "complete");
    for (const secret of ["第一", "第二", env.LEAFCODE_PI_BACKEND_TOKEN]) assert.ok(!ledger.includes(secret));
  }
  t.diagnostic(JSON.stringify({ sdkLoaded: true, realBackendEntry: true, pidStable: true, generationStable: true, sameAgentSession: true, sessionIdStable: true, leaseTokenStable: true, heartbeatWhileWebAbsent: true, calls: end.calls, sdkResultsOnce: 2, nextRestarts: 2, operationReplayRefusals: 3, sseReconnectResult: true, nextOwnerData: false, runtimeOwnerStable: true, externalFetchForwarded: 0, externalFetchBlocked: end.deniedNetwork, traces }));
});
