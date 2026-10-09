import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHostBuildInfo } from "./build-info.js";
import { createLlamaControlServer, closeControlServer, listenControlServer } from "./llama-control-server.js";
import { HOST_BUILD_INFO_HEADER, HOST_BUILD_OPERATION_HEADER } from "../../shared/host-build-info-contract.mjs";
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const require = createRequire(join(ROOT, "web/package.json")), ts = require("typescript");
async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
async function stop(child) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const closed = new Promise(r => child.once("exit", r)); child.kill(); await closed; }

test("real Next build-info is a Host client: Backend absent, Web stop/restart does not repeat accepted Git", { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-next-host-build-")), app = join(root, "app"), children = [];
  const oldRole = process.env.LEAFCODE_PI_PROCESS_ROLE; process.env.LEAFCODE_PI_PROCESS_ROLE = "host";
  let host, release; const gate = new Promise(r => release = r);
  t.after(async () => { release(); for (const child of children) await stop(child); await closeControlServer(host);
    if (oldRole === undefined) delete process.env.LEAFCODE_PI_PROCESS_ROLE; else process.env.LEAFCODE_PI_PROCESS_ROLE = oldRole;
    rmSync(root, { recursive: true, force: true }); });
  const aliases = { "@": "web/src", "@shared": "shared" }, copied = new Set();
  function copy(source) {
    if (copied.has(source)) return; copied.add(source); const dest = join(app, "source", relative(ROOT, source)); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(source, dest);
    for (const { fileName } of ts.preProcessFile(readFileSync(source, "utf8"), true, true).importedFiles) {
      const alias = Object.keys(aliases).find(key => fileName.startsWith(key + "/"));
      const target = fileName.startsWith(".") ? resolve(dirname(source), fileName) : alias ? join(ROOT, aliases[alias], fileName.slice(alias.length + 1)) : null;
      if (!target) { assert.ok(["node:fs", "node:crypto", "node:path", "node:os"].includes(fileName), fileName); continue; }
      const found = [target, target + ".ts", target + ".mjs"].find(existsSync); assert.ok(found, target); copy(found);
      if (found.endsWith(".mjs") && existsSync(found.replace(/\.mjs$/, ".d.mts"))) copy(found.replace(/\.mjs$/, ".d.mts"));
    }
  }
  const source = join(ROOT, "web/src/app/api/build-info/route.ts"); copy(source);
  assert.ok(![...copied].some(path => /[\\/](backend|host|node_modules)[\\/]/.test(relative(ROOT, path))), "Next source closure must contain no owner/SDK modules");
  mkdirSync(join(app, "app/api/build-info"), { recursive: true }); copyFileSync(source, join(app, "app/api/build-info/route.ts"));
  writeFileSync(join(app, "app/layout.tsx"), "export default function Layout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>}");
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "leafcode-host-client-fixture", private: true }));
  writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "esnext"], module: "esnext", moduleResolution: "bundler", jsx: "preserve", strict: true, esModuleInterop: true, skipLibCheck: true, baseUrl: ".", paths: Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key + "/*", ["source/" + value + "/*"]])) } }));
  writeFileSync(join(app, "next.config.mjs"), "export default {experimental:{cpus:2}};");
  symlinkSync(join(ROOT, "web/node_modules"), join(app, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const hostPort = await freePort(), webPort = await freePort(), env = { ...process.env, NODE_OPTIONS: "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    LEAFCODE_PI_PROCESS_ROLE: "next", LEAFCODE_PI_DATA_DIR: join(root, "data"), LEAFCODE_PI_WEBUI_AUTH: "required", LEAFCODE_PI_WEBUI_TOKEN: "fixture-browser",
    LEAFCODE_PI_HOST_CONTROL_URL: `http://127.0.0.1:${hostPort}`, LEAFCODE_PI_BACKEND_TOKEN: "", LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:1" };
  const cli = require.resolve("next/dist/bin/next");
  function start(args) { const child = spawn(process.execPath, [cli, ...args], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(child); let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => output = (output + chunk).slice(-16000)); return { child, output: () => output }; }
  const built = start(["build", "--webpack", app]); const code = await new Promise((resolve, reject) => { built.child.once("error", reject); built.child.once("exit", resolve); }); assert.equal(code, 0, built.output());
  let pulls = 0, entered = false, operationId, current = "a".repeat(40);
  const info = createHostBuildInfo({ repoRoot: root, dataDir: root, git: async (_root, args) => {
    if (args[0] === "pull") { pulls++; entered = true; await gate; current = "b".repeat(40); return { code: 0, stdout: "" }; }
    return args[0] === "log" ? { code: 0, stdout: `${current}\n2026-10-09T00:00:00Z\n` } : { code: 1, stdout: "" };
  } });
  host = createLlamaControlServer({ controlPort: hostPort, onBuildInfoRead: () => info.read(), onBuildInfoUpdate: id => { operationId = id; return info.update(id); } }); await listenControlServer(host, hostPort);
  const base = `http://127.0.0.1:${webPort}/api/build-info`, headers = { cookie: "leafcode-pi-token=fixture-browser" };
  async function startWeb() {
    const running = start(["start", "-p", String(webPort), "-H", "127.0.0.1", app]);
    for (let i = 0; i < 150; i++) { try { const res = await fetch(base, { headers, signal: AbortSignal.timeout(1000) }); if (res.status === 200) return running.child; } catch {}
      if (running.child.exitCode !== null) throw Error(running.output()); await delay(50); } throw Error("Next did not become ready: " + running.output());
  }
  let web = await startWeb(); assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { method: "POST", headers: { ...headers, origin: "https://outside.invalid" } })).status, 403); assert.equal(pulls, 0);
  const posting = fetch(base, { method: "POST", headers, signal: AbortSignal.timeout(15000) }).catch(() => null);
  for (let i = 0; i < 150 && !entered; i++) await delay(10); assert.equal(entered, true); await stop(web);
  await assert.rejects(fetch(base, { headers, signal: AbortSignal.timeout(1000) }));
  release(); await posting;
  for (let i = 0; i < 150; i++) { if (readFileSync(join(root, "host-build-info-command.json"), "utf8").includes("complete")) break; await delay(10); }
  web = await startWeb(); const result = await (await fetch(base, { headers })).json(); assert.equal(result.commit, "b".repeat(40)); assert.equal(pulls, 1);
  const duplicate = await fetch(`http://127.0.0.1:${hostPort}/build-info`, { method: "POST", headers: { [HOST_BUILD_INFO_HEADER]: "1", [HOST_BUILD_OPERATION_HEADER]: operationId } }); assert.equal(duplicate.status, 409); assert.equal(pulls, 1);
  await stop(web); t.diagnostic(`real Next production: ${copied.size} source files, Backend absent, Host admission survives Web restart, one pull`);
});
