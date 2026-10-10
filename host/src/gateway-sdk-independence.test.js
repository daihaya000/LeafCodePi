import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildSpaGeneration, spaBuildEnvironment } from "../../scripts/spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
async function until(check, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(50); } throw Error(label); }
async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
async function stop(child) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exit = new Promise(r => child.once("exit", r)); child.kill(); await Promise.race([exit, delay(3000)]); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; } }

test("real headless Host controls/crash-recovers native gateway without replacing real Backend SDK/session/lease/heartbeat", { timeout: 300000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "p3-host-sdk-")), candidate = join(root, "candidate"), data = join(root, "sdk-data"), hostData = join(root, "host-data"), agent = join(root, "agent"), mirror = join(root, "build"), mirrorRoot = join(mirror, ".spa"), children = [], links = [], pending = new Map();
  t.after(async () => {
    for (const child of [...children].reverse()) await stop(child);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("Fixture closed")); }
    for (const link of links) if (existsSync(link)) unlinkSync(link);
    rmSync(root, { recursive: true, force: true });
  });
  for (const folder of [candidate, data, hostData, agent, join(candidate, "extensions")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], promptTemplates: [], compaction: { enabled: false }, retry: { enabled: false } }));
  for (const folder of ["host/src", "shared", "scripts", "gateway/src", "backend/core"]) cpSync(join(ROOT, folder), join(candidate, folder), { recursive: true });
  const development = process.env.LEAFCODE_TEST_GATEWAY_DEV === "1";
  if (development) {
    for (const name of ["src", "public", "index.html", "vite.config.ts", "postcss.config.mjs"]) if (existsSync(join(ROOT, "web", name))) cpSync(join(ROOT, "web", name), join(candidate, "web", name), { recursive: true });
  }
  for (const folder of development ? ["host", "backend", "web"] : ["host", "backend"]) {
    for (const file of ["package.json", "package-lock.json"]) if (existsSync(join(ROOT, folder, file))) cpSync(join(ROOT, folder, file), join(candidate, folder, file));
    const link = join(candidate, folder, "node_modules"); symlinkSync(join(ROOT, folder, "node_modules"), link, process.platform === "win32" ? "junction" : "dir"); links.push(link);
  }
  // Only this disposable checkout's CLI fails. Its real generation APIs remain unchanged.
  const builder = join(candidate, "scripts/spa-build-generation.mjs"), original = readFileSync(builder, "utf8");
  writeFileSync(builder, original.slice(0, original.indexOf("if (process.argv[1]")) + '\nif (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { console.error("fixture build failure"); process.exitCode = 1; }\n');
  const bundle = join(ROOT, "backend/runtime/runtime.bundle.mjs"), sdkGeneration = createHash("sha256").update(readFileSync(bundle)).digest("hex").slice(0, 16), token = "fixture-sdk-" + randomUUID();
  const backendEnv = { ...spaBuildEnvironment(), NODE_ENV: "test", NODE_OPTIONS: "", HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, APPDATA: join(root, "roaming"), LEAFCODE_PI_DATA_DIR: data,
    LEAFCODE_PI_DEFAULT_DIR: join(root, "workspaces"), LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_BACKEND_PORT: "0", LEAFCODE_PI_BACKEND_RUNTIME: "1", LEAFCODE_PI_MCP_NATIVE: "",
    LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: bundle, LEAFCODE_PI_PUSHOVER_TOKEN: "", LEAFCODE_PI_PUSHOVER_USER: "" };
  let backendOut = "", backendErr = "";
  const backend = spawn(process.execPath, [join(ROOT, "backend/src/sdk-web-independence-fixture.mjs")], { cwd: root, env: backendEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(backend);
  backend.stdout.on("data", chunk => backendOut += chunk); backend.stderr.on("data", chunk => backendErr += chunk);
  backend.on("message", message => { const waiter = pending.get(message?.reply); if (waiter) { pending.delete(message.reply); clearTimeout(waiter.timer); message.error ? waiter.reject(Error(message.error)) : waiter.resolve(message.value); } });
  const command = (action, extra = {}) => new Promise((resolve, reject) => { const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(Error("IPC deadline: " + action + backendErr)); }, 15000); pending.set(id, { resolve, reject, timer }); backend.send({ id, action, ...extra }); });
  const backendBase = await until(() => { assert.equal(backend.exitCode, null, backendErr); if (backendErr.includes("Backend startup failed")) throw Error(backendErr); for (const line of backendOut.split(/\r?\n/)) try { const message = JSON.parse(line); if (message.type === "backend_listening") return `http://127.0.0.1:${message.port}`; } catch {} }, "Backend listen deadline");
  const privateHeaders = { authorization: `Bearer ${token}`, "x-leafcode-backend-protocol": "1" };
  await until(async () => (await (await fetch(backendBase + "/internal/health", { headers: privateHeaders })).json()).ready, "SDK readiness deadline");
  const generation = await buildSpaGeneration({ mirrorRoot, offline: true, log: text => process.stdout.write(text) });
  const port = await freePort(), control = await freePort(), base = `http://127.0.0.1:${port}`, controlBase = `http://127.0.0.1:${control}`;
  const hostEnv = { ...spaBuildEnvironment(), LEAFCODE_PI_MODE: development ? "dev" : "prod", LEAFCODE_PI_HEADLESS: "1", LEAFCODE_PI_TRAY: "0", LEAFCODE_PI_NO_BROWSER: "1", LEAFCODE_PI_LCP_AUTO_UPDATE: "0", LEAFCODE_PI_BACKEND: "0",
    LEAFCODE_PI_SKIP_STALE_REBUILD: "1", LEAFCODE_PI_BUILD_DIR: mirror, LEAFCODE_PI_DATA_DIR: hostData, LEAFCODE_PI_HOST: "127.0.0.1", LEAFCODE_PI_PORT: String(port), LEAFCODE_PI_HOST_CONTROL_PORT: String(control), LEAFCODE_PI_LLAMA_PORT: String(await freePort()),
    LEAFCODE_PI_BACKEND_URL: backendBase, LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_GENERATION: sdkGeneration };
  let hostOut = "", hostErr = "";
  const host = spawn(process.execPath, [join(candidate, "host/src/index.js")], { cwd: candidate, env: hostEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(host);
  host.stdout.on("data", chunk => hostOut += chunk); host.stderr.on("data", chunk => hostErr += chunk);
  const gatewayPids = () => [...hostOut.matchAll(/Gateway child pid=(\d+) generation=([a-f0-9-]+)/g)].map(match => ({ pid: Number(match[1]), generation: match[2] }));
  await until(async () => { assert.equal(host.exitCode, null, hostErr); try { return hostOut.includes("Headless mode") && (await fetch(base + "/login")).ok; } catch { return false; } }, "Host startup deadline");
  const firstPid = gatewayPids().at(-1); assert.equal(firstPid.generation, generation.id);
  if (development) { const client = await fetch(base + "/@vite/client"); assert.equal(client.status, 200); assert.ok((await client.text()).includes("vite")); }
  const created = await command("create"); assert.equal(created.realAgentSession, true); assert.equal(created.liveCount, 1);
  const before = await until(async () => { const value = await command("sample"); return value.activeGate === 1 && value; }, "SDK stream gate deadline");
  assert.equal(before.calls, 1); assert.equal(before.lease.pid, backend.pid);
  async function identity() {
    const value = await command("sample"); assert.equal(value.pid, before.pid); assert.equal(value.sessionId, before.sessionId); assert.equal(value.sameSession, true); assert.equal(value.realAgentSession, true); assert.deepEqual(value.owner, before.owner);
    assert.equal(value.lease.token, before.lease.token); assert.equal(value.lease.acquiredAt, before.lease.acquiredAt); assert.equal(value.calls, 1); assert.equal(value.networkDisabled, true);
    const health = await (await fetch(backendBase + "/internal/health", { headers: privateHeaders })).json(); assert.equal(health.runtimeGeneration, sdkGeneration); assert.equal(health.ready, true); return value;
  }
  const restart = await fetch(controlBase + "/restart/webui", { method: "POST", headers: { origin: base } }); assert.equal(restart.status, 202, await restart.clone().text());
  await until(() => gatewayPids().length >= 2 && gatewayPids().at(-1).pid !== firstPid.pid, "Host restart deadline");
  assert.equal(gatewayPids().at(-1).generation, generation.id); assert.match(hostErr + hostOut, /fixture build failure/); await identity();
  assert.equal((await fetch(base + "/login")).status, 200);
  const crashPid = gatewayPids().at(-1).pid; process.kill(crashPid, "SIGKILL");
  await until(() => gatewayPids().length >= 3 && gatewayPids().at(-1).pid !== crashPid, "Host crash-restart deadline"); await identity();
  // Observe a genuine 15s lease tick while one SDK request remains held across both Web restarts.
  await delay(16000); const after = await identity(); assert.equal(after.streaming, true); assert.ok(after.lease.heartbeatAt > before.lease.heartbeatAt);
  const health = await (await fetch(base + "/api/health")).json(); assert.equal(health.ok, true); assert.equal(health.engineOk, true);
  const detail = await (await fetch(base + `/api/tasks/${created.task.id}`)).json(); assert.ok(JSON.stringify(detail).includes("finite SDK probe")); assert.ok(!JSON.stringify(detail).includes(token));
  await command("release", { gate: 1 }); await until(async () => !(await command("sample")).streaming, "SDK completion deadline");
  assert.ok(JSON.stringify(await (await fetch(base + `/api/tasks/${created.task.id}`)).json()).includes("SDK第一結果"));
  assert.equal(JSON.parse(readFileSync(join(mirrorRoot, "state.json"))).current, generation.id);
  await stop(backend);
  const unavailable = await (await fetch(base + "/api/health")).json(); assert.equal(unavailable.ok, true); assert.equal(unavailable.engineOk, false);
  const recover = await fetch(controlBase + "/restart/webui", { method: "POST", headers: { origin: base } }); assert.equal(recover.status, 202);
  await until(() => gatewayPids().length >= 4, "Web recovery with unavailable Backend deadline");
  assert.equal((await fetch(base + "/login")).status, 200);
  t.diagnostic(JSON.stringify({ development, host: host.pid, gateways: gatewayPids(), backend: backend.pid, sdkGeneration, sameSession: true, sameLease: true, heartbeatAdvanced: true, providerCalls: after.calls, deniedNetwork: after.deniedNetwork, sealedGeneration: generation.id }));
});
