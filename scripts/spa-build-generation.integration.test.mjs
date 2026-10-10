import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildSpaGeneration, selectSpaGeneration, spaBuildEnvironment } from "./spa-build-generation.mjs";
import { startSpaWithFallback } from "../host/src/spa-build.js";

test("external mirror compiles and seals two real Vite/gateway generations; failed build/start retain the old native runtime", { timeout: 300000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "spa-pair-production-")), mirrorRoot = join(root, "mirror/.spa"), children = [];
  t.after(async () => {
    for (const run of children) if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill(); await Promise.race([run.exited, delay(3000)]); if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill("SIGKILL"); await run.exited; } }
    rmSync(root, { recursive: true, force: true });
  });
  const log = text => process.stdout.write(text);
  const first = await buildSpaGeneration({ mirrorRoot, offline: true, log });
  const firstIndex = readFileSync(join(first.staticRoot, "index.html"), "utf8"), firstEntry = readFileSync(first.entry, "utf8");
  assert.equal(Object.keys(first.files).some(path => /node_modules\/(?:next|@earendil)|^(?:backend|host|extensions)\//.test(path)), false);
  function launch(generation, broken = false) {
    const env = { ...spaBuildEnvironment(), LEAFCODE_PI_PORT: "0", LEAFCODE_PI_BIND_HOST: "127.0.0.1", LEAFCODE_PI_SPA_DIR: broken ? join(root, "no-build") : generation.staticRoot,
      LEAFCODE_PI_WEBUI_AUTH: "required", LEAFCODE_PI_WEBUI_TOKEN: "fixture-pair-token", LEAFCODE_PI_DATA_DIR: join(root, "data") };
    const child = spawn(process.execPath, [generation.entry], { cwd: generation.cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
    const run = { child, exited, output: () => ({ out, err }) }; children.push(run); return run;
  }
  async function origin(run) {
    for (let i = 0; i < 300; i++) {
      if (run.child.exitCode !== null) throw Error("Isolated gateway failed startup: " + run.output().err);
      const match = run.output().out.match(/\{"type":"gateway_listening","port":(\d+)\}/);
      if (match) return `http://127.0.0.1:${match[1]}`; await delay(20);
    }
    throw Error("Isolated gateway start deadline");
  }
  const firstProcess = launch(first), firstOrigin = await origin(firstProcess);
  assert.equal(await (await fetch(firstOrigin + "/login")).text(), firstIndex);
  const second = await buildSpaGeneration({ mirrorRoot, offline: true, log });
  assert.notEqual(second.id, first.id); assert.equal((await selectSpaGeneration(mirrorRoot)).id, second.id);
  assert.equal(readFileSync(first.entry, "utf8"), firstEntry); assert.equal(await (await fetch(firstOrigin + "/login")).text(), firstIndex);
  const pointer = readFileSync(join(mirrorRoot, "state.json"), "utf8");
  await assert.rejects(buildSpaGeneration({ mirrorRoot, compileBuild() { throw Error("fixture compile failure"); } }), /compile failure/);
  assert.equal(readFileSync(join(mirrorRoot, "state.json"), "utf8"), pointer);
  const starts = [];
  const restored = await startSpaWithFallback({ mirrorRoot, start: async generation => {
    starts.push(generation.id); const run = launch(generation, generation.id === second.id); const base = await origin(run); return { run, base };
  } });
  assert.deepEqual(starts, [second.id, first.id]); assert.equal(restored.fallback, true); assert.equal((await selectSpaGeneration(mirrorRoot)).id, first.id);
  for (const path of ["/", "/settings", "/task/task-a", "/bots", "/bots/bot-a", "/bots/rooms/room-a", "/login"]) {
    const response = await fetch(restored.process.base + path, { headers: { authorization: "Bearer fixture-pair-token" } }); assert.equal(response.status, 200); assert.equal(await response.text(), firstIndex);
  }
  const health = await (await fetch(restored.process.base + "/api/health")).json(); assert.equal(health.ok, true); assert.equal(health.engineOk, false);
  const assets = [...firstIndex.matchAll(/src="(\/assets\/[^" ]+\.js)"/g)].map(match => match[1]); assert.ok(assets.length);
  for (const asset of assets) assert.equal((await fetch(restored.process.base + asset)).status, 200);
  t.diagnostic(JSON.stringify({ first: first.id, second: second.id, restored: restored.generation.id, sealedFiles: Object.keys(first.files).length, sourceDigest: first.sourceDigest, nativeStarts: starts.length, routes: 7, mirrorRoot }));
});
