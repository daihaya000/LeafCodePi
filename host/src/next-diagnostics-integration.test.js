import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createBackendServer, listenBackend, closeBackend } from "../../backend/src/server.mjs";
import { createLlamaWebUiControl } from "./llama-webui-control.js";
import { createLlamaControlServer, listenControlServer, closeControlServer } from "./llama-control-server.js";
import { publicBackendHealthBody } from "../../shared/backend-health-contract.mjs";
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url))), require = createRequire(join(ROOT, "web/package.json")), ts = require("typescript");
async function port() { const s = netServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function stop(c) { if (!c || c.exitCode !== null || c.signalCode !== null) return; const done = new Promise(r => c.once("exit", r)); c.kill(); await done; }
test("real Next diagnostic/llama ingress remains thin; Backend loss does not block readiness or Host; load survives Web restart", { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-next-diagnostics-")), app = join(root, "app"), data = join(root, "data"), children = [], copied = new Set();
  let backend, host, engine; const previous = { role: process.env.LEAFCODE_PI_PROCESS_ROLE, port: process.env.LEAFCODE_PI_LLAMA_PORT, auth: process.env.LEAFCODE_PI_WEBUI_AUTH }; process.env.LEAFCODE_PI_PROCESS_ROLE = "host"; process.env.LEAFCODE_PI_WEBUI_AUTH = "required";
  t.after(async () => { for (const c of children) await stop(c); if (host) await closeControlServer(host); if (backend) await closeBackend(backend); if (engine) await new Promise(r => engine.close(r));
    for (const [key, value] of [["LEAFCODE_PI_PROCESS_ROLE", previous.role], ["LEAFCODE_PI_LLAMA_PORT", previous.port], ["LEAFCODE_PI_WEBUI_AUTH", previous.auth]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true }); });
  const aliases = { "@": "web/src", "@shared": "shared" };
  function copy(source) {
    if (copied.has(source)) return; copied.add(source); const dest = join(app, "source", relative(ROOT, source)); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(source, dest);
    for (const { fileName } of ts.preProcessFile(readFileSync(source, "utf8"), true, true).importedFiles) {
      const alias = Object.keys(aliases).find(key => fileName.startsWith(key + "/")); const target = fileName.startsWith(".") ? resolve(dirname(source), fileName) : alias ? join(ROOT, aliases[alias], fileName.slice(alias.length + 1)) : null;
      if (!target) { assert.ok(fileName.startsWith("node:") || ["next/server", "undici"].includes(fileName), fileName); continue; }
      const found = [target, target + ".ts", target + ".mjs"].find(existsSync); assert.ok(found, target); assert.ok(!relative(ROOT, found).replaceAll("\\", "/").startsWith("backend/")); copy(found);
      if (found.endsWith(".mjs") && existsSync(found.replace(/\.mjs$/, ".d.mts"))) copy(found.replace(/\.mjs$/, ".d.mts"));
    }
  }
  for (const route of ["health", "llama-server/models", "llama-server/ensure-loaded", "llama-server/[action]"]) {
    const source = join(ROOT, "web/src/app/api", route, "route.ts"); copy(source); const dest = join(app, "app/api", route, "route.ts"); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(source, dest);
  }
  writeFileSync(join(app, "app/layout.tsx"), "export default function Layout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>}");
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "leafcode-diagnostics-fixture", private: true }));
  writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "esnext"], module: "esnext", moduleResolution: "bundler", jsx: "preserve", strict: true, esModuleInterop: true, skipLibCheck: true, baseUrl: ".", paths: Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key + "/*", ["source/" + value + "/*"]])) } }));
  writeFileSync(join(app, "next.config.mjs"), "export default {experimental:{cpus:2}};"); symlinkSync(join(ROOT, "web/node_modules"), join(app, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const hostPort = await port(), webPort = await port(), token = "fixture-internal-token-" + "x".repeat(32); let backendReady = true, loading = false, loaded = false, posts = 0;
  backend = createBackendServer({ token, isReady: () => backendReady, jsonBusinessRequestAction: async input => ({ status: 200, headers: {}, body: publicBackendHealthBody({ ok: true, engine: "pi", engineOk: true, version: "1.0.0", modelCount: 2, dataDir: "/PRIVATE", warnings: ["PRIVATE"], startedAt: 1 }, 200, input.authorized) }) }); const back = await listenBackend(backend, 0);
  engine = httpServer((req, res) => { res.setHeader("content-type", "application/json"); if (req.method === "POST") { posts++; loading = true; res.end('{"ok":true}'); return; } res.end(JSON.stringify({ data: [{ id: "model", status: { value: loaded ? "loaded" : loading ? "loading" : "unloaded" } }] })); }); await new Promise(r => engine.listen(0, "127.0.0.1", r)); process.env.LEAFCODE_PI_LLAMA_PORT = String(engine.address().port);
  const models = join(root, "models"); mkdirSync(models); writeFileSync(join(models, "model.gguf"), "fixture"); mkdirSync(join(data, "settings"), { recursive: true });
  writeFileSync(join(data, "settings/llama-server-config.json"), JSON.stringify({ value: JSON.stringify({ effort: "low", contextLength: 8192, parallel: 1, modelDir: models, modelFile: "model.gguf" }) }));
  const control = createLlamaWebUiControl({ repoRoot: root, dataDir: data, service: { status: async () => ({ running: true, pid: null, port: 8081, health: "ok", listeningPids: [] }) }, waitMs: 15000 });
  host = createLlamaControlServer({ controlPort: hostPort, onLlamaWebUiControl: input => control.handle(input) }); await listenControlServer(host, hostPort);
  const env = { ...process.env, NODE_OPTIONS: "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", LEAFCODE_PI_PROCESS_ROLE: "next", LEAFCODE_PI_DATA_DIR: data,
    LEAFCODE_PI_HOST_CONTROL_URL: `http://127.0.0.1:${hostPort}`, LEAFCODE_PI_BACKEND_URL: `http://127.0.0.1:${back.port}`, LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "",
    LEAFCODE_PI_WEBUI_AUTH: "required", LEAFCODE_PI_WEBUI_TOKEN: "fixture-browser" };
  const cli = require.resolve("next/dist/bin/next"); function start(args) { const child = spawn(process.execPath, [cli, ...args], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(child); let output = ""; for (const s of [child.stdout, child.stderr]) s.on("data", b => output = (output + b).slice(-16000)); return { child, output: () => output }; }
  const build = start(["build", "--webpack", app]); assert.equal(await new Promise(r => build.child.once("exit", r)), 0, build.output());
  const base = `http://127.0.0.1:${webPort}`, headers = { cookie: "leafcode-pi-token=fixture-browser" };
  async function web() { const run = start(["start", "-p", String(webPort), "-H", "127.0.0.1", app]); for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).status === 200) return run.child; } catch {} if (run.child.exitCode !== null) throw Error(run.output()); await delay(50); } throw Error(run.output()); }
  let running = await web(); const publicHealth = await (await fetch(base + "/api/health")).json(); assert.equal(publicHealth.modelCount, 2); assert.ok(!JSON.stringify(publicHealth).includes("PRIVATE")); assert.notEqual(publicHealth.startedAt, 1);
  assert.equal((await (await fetch(base + "/api/health", { headers })).json()).dataDir, "/PRIVATE"); assert.equal((await fetch(base + "/api/llama-server/status")).status, 401);
  backendReady = false; const unavailable = await (await fetch(base + "/api/health")).json(); assert.equal(unavailable.ok, true); assert.equal(unavailable.backendAvailable, false);
  const listing = await (await fetch(base + "/api/llama-server/models?dir=" + encodeURIComponent(models), { headers })).json(); assert.deepEqual(listing.models, ["model.gguf"]);
  const pending = fetch(base + "/api/llama-server/ensure-loaded", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(20000) }).catch(() => null);
  for (let i = 0; i < 150 && !posts; i++) await delay(10); assert.equal(posts, 1); await stop(running); await assert.rejects(fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })); await pending;
  running = await web(); const joined = fetch(base + "/api/llama-server/ensure-loaded", { method: "POST", headers, body: "{}" }); loaded = true; const result = await (await joined).json(); assert.equal(result.ok, true); assert.equal(result.modelId, "model"); assert.equal(posts, 1);
  await stop(running); t.diagnostic(`real Next production: ${copied.size} source files, no owner/SDK imports, private metadata gating, readiness independent of Backend, one load across Web restart`);
});
