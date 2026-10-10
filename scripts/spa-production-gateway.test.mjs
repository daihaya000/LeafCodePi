import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildGateway, gatewayGraph } from "./build-gateway.mjs";
import { createSecretCanaries, withCanaryEnvironment } from "./spa-secret-canary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url))), web = join(ROOT, "web");
const require = createRequire(join(web, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const { chromium } = require("playwright");

function launch(children, entry, env, args = [], cwd = dirname(entry)) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })); });
  const run = { child, exited, output: () => ({ stdout, stderr }) }; children.push(run); return run;
}
async function listening(run) {
  for (let i = 0; i < 300; i++) {
    assert.equal(run.child.exitCode, null, run.output().stderr);
    const record = run.output().stdout.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.type === "gateway_listening");
    if (record) return `http://127.0.0.1:${record.port}`;
    await delay(20);
  }
  throw Error("Production gateway did not start");
}

test("fresh Vite output is served by the compiled native production gateway, not dev/preview; auth, API failure and readiness remain independent", { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-spa-production-gateway-")), candidate = join(root, "candidate"), output = join(root, "spa");
  const children = [];
  t.after(async () => {
    // Kill children before deleting their module trees; a cleanup failure must never strand a server.
    for (const run of children.reverse()) if (run.child.exitCode === null && run.child.signalCode === null) {
      run.child.kill(); await Promise.race([run.exited, delay(3000)]);
      if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill("SIGKILL"); await run.exited; }
    }
    unlinkSync(join(candidate, "web/node_modules"));
    rmSync(root, { recursive: true, force: true });
  });
  const graph = gatewayGraph();
  for (const file of [...graph.sources.keys(), "docs/plans/next-thin-phase0.json", "gateway/package.json", "gateway/package-lock.json"]) {
    if (file === "gateway/src/routes.mjs") continue;
    const target = join(candidate, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(ROOT, file), target);
  }
  cpSync(join(ROOT, "shared"), join(candidate, "shared"), { recursive: true });
  symlinkSync(join(web, "node_modules"), join(candidate, "web/node_modules"), process.platform === "win32" ? "junction" : "dir");
  const gateway = buildGateway(candidate); assert.deepEqual([gateway.routes, gateway.operations], [165, 265]);
  await withCanaryEnvironment(createSecretCanaries(), () => build({ configFile: join(web, "vite.config.ts"), envDir: root, logLevel: "silent", build: { outDir: output, emptyOutDir: true } }));
  const index = readFileSync(join(output, "index.html"), "utf8");
  const script = [...index.matchAll(/src="(\/assets\/[^" ]+\.js)"/g)].map(match => match[1]); assert.ok(script.length);
  const entry = join(gateway.output, "gateway/src/index.mjs");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HOME|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS)$/.test(name)));
  Object.assign(env, { NODE_ENV: "production", LEAFCODE_PI_PORT: "0", LEAFCODE_PI_BIND_HOST: "127.0.0.1", LEAFCODE_PI_WEBUI_AUTH: "required", LEAFCODE_PI_WEBUI_TOKEN: "fixture-production-token", LEAFCODE_PI_DATA_DIR: join(root, "data") });
  // P1 intentionally never installed or started a gateway in the live checkout.
  // Install its sole locked runtime dependency in this isolated candidate, offline.
  const install = launch(children, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), env, ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], join(candidate, "gateway"));
  const installed = await install.exited; assert.equal(installed.code, 0, installed.stderr);
  for (const directory of [undefined, "", "relative-build", join(root, "missing-build")]) {
    const broken = launch(children, entry, { ...env, ...(directory === undefined ? {} : { LEAFCODE_PI_SPA_DIR: directory }) });
    const failed = await broken.exited; assert.notEqual(failed.code, 0); assert.doesNotMatch(failed.stdout, /gateway_listening/); assert.match(failed.stderr, /SPA build directory/);
  }
  const run = launch(children, entry, { ...env, LEAFCODE_PI_SPA_DIR: output }), origin = await listening(run);
  const approved = { authorization: "Bearer fixture-production-token" };
  for (const path of ["/", "/task/task-a", "/settings", "/bots", "/bots/bot-a", "/bots/rooms/room-a", "/login"]) for (let reload = 0; reload < 2; reload++) {
    const response = await fetch(origin + path + "?fixture=1", { headers: approved }); assert.equal(response.status, 200); assert.equal(await response.text(), index); assert.equal(response.headers.get("cache-control"), "no-store");
    const head = await fetch(origin + path, { method: "HEAD", headers: approved }); assert.equal(head.status, 200); assert.equal(await head.text(), ""); assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(index));
  }
  for (const path of script) { const response = await fetch(origin + path); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /javascript/); assert.match(response.headers.get("cache-control"), /immutable/); }
  for (const path of ["/assets/missing.js", "/missing.png"]) { const response = await fetch(origin + path, { redirect: "manual" }); assert.equal(response.status, 404); assert.match(response.headers.get("content-type"), /json/); }
  const unknown = await fetch(origin + "/api/unknown", { headers: approved }); assert.equal(unknown.status, 404); assert.match(unknown.headers.get("content-type"), /json/);
  const unavailable = await fetch(origin + "/api/settings", { headers: approved }); assert.equal(unavailable.status, 503); assert.match(unavailable.headers.get("content-type"), /json/);
  const healthResponse = await fetch(origin + "/api/health"), health = await healthResponse.json();
  assert.equal(healthResponse.status, 200, JSON.stringify(health)); assert.equal(health.ok, true); assert.equal(health.engineOk, false); assert.equal(health.backendAvailable, false);
  const cross = await fetch(origin + "/api/settings/pushover-notifications-enabled", { method: "PUT", headers: { ...approved, origin: "https://evil.invalid", "content-type": "application/json" }, body: '{"value":"1"}' }); assert.equal(cross.status, 403);
  const same = await fetch(origin + "/api/settings/pushover-notifications-enabled", { method: "PUT", headers: { ...approved, origin, "content-type": "application/json" }, body: '{"value":"1"}' }); assert.equal(same.status, 503);
  const browser = await chromium.launch({ headless: true, ...(process.env.LEAFCODE_TEST_CHROMIUM ? { executablePath: process.env.LEAFCODE_TEST_CHROMIUM } : {}) });
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [], requested = [];
      page.on("pageerror", error => errors.push(error.message));
      await context.route("**/*", route => { const url = new URL(route.request().url()); requested.push(url.pathname); assert.equal(url.origin, origin); return route.continue(); });
      await page.goto(origin + "/login"); await page.getByRole("heading", { name: "LeafCodePi にサインイン" }).waitFor();
      assert.ok(requested.some(path => path.startsWith("/assets/"))); assert.equal(requested.some(path => /@vite|@fs|src\/spa/.test(path)), false); assert.deepEqual(errors, []);
      await context.addCookies([{ name: "leafcode-pi-token", value: "fixture-production-token", url: origin }]);
      await page.goto(origin + "/settings"); await page.getByRole("alert").filter({ hasText: "保存済み設定を保護" }).waitFor();
      assert.equal(requested.some(path => path.endsWith("/events")), false); assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
  run.child.kill(); assert.equal((await run.exited).signal !== null || run.child.exitCode !== null, true);
  const restart = launch(children, entry, { ...env, LEAFCODE_PI_SPA_DIR: output }), restarted = await listening(restart);
  assert.equal(await (await fetch(restarted + "/login")).text(), index);
  t.diagnostic(JSON.stringify({ api: [gateway.routes, gateway.operations], modules: gateway.runtimeModules, directReloadHead: 42, viewports: 2, noBuildFailures: 4, health: { ok: health.ok, engineOk: health.engineOk }, output }));
});
