import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildWeb, buildWebOptions } from "./build-web.mjs";
import { productionStartOptions, startProductionGateway } from "./start-production-gateway.mjs";
import { dependencyReferences } from "./production-boundary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("canonical build/start/typecheck and browser/gateway gates are native, not legacy Next invocations", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "web/package.json")));
  assert.equal(pkg.scripts.build, "node ../scripts/build-web.mjs");
  assert.equal(pkg.scripts.start, "node ../scripts/start-production-gateway.mjs");
  assert.equal(pkg.scripts.typecheck, "tsc -p tsconfig.spa.json");
  assert.equal(pkg.scripts["check:browser"], "node ../scripts/production-boundary.mjs --browser");
  assert.equal(pkg.scripts["check:gateway"], "node ../scripts/production-boundary.mjs --gateway");
  assert.ok(!Object.values(pkg.scripts).some(value => /check-next-|next (?:build|start|dev)/.test(value)));
  const ts = createRequire(join(ROOT, "web/package.json"))("typescript"), visited = new Set();
  function visit(file) {
    file = realpathSync(file); if (visited.has(file)) return; visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const edge of dependencyReferences(source, file, ts, { declaration: true })) {
      assert.doesNotMatch(edge.specifier, /legacy-next|check-next-|web-build-mirror|^next(?:\/|$)/, `${file}: production command must not reach legacy Next code`);
      if (edge.specifier.startsWith(".")) visit(resolve(dirname(file), edge.specifier));
    }
  }
  for (const name of ["build-web.mjs", "start-production-gateway.mjs", "build-gateway.mjs", "extension-dependencies.mjs"]) visit(join(ROOT, "scripts", name));
  assert.ok(visited.size > 5);
  const host = readFileSync(join(ROOT, "host/src/index.js"), "utf8");
  assert.match(host, /extension-dependencies\.mjs/); assert.doesNotMatch(host, /(?:build-web|web-build-mirror|legacy-next-build)\.mjs/);
});

test("build command publishes only the pair and forwards explicit options, not an SDK/Host restart", async () => {
  const args = ["--offline", "--mirror", join(ROOT, "../test-build/.spa")], options = buildWebOptions(args, {});
  let calls = 0;
  const result = await buildWeb({ args, env: {}, build: async request => { calls++; assert.deepEqual(request.checkout, ROOT); assert.equal(request.offline, true); assert.equal(request.mirrorRoot, options.mirrorRoot); return { id: "fixture", directory: "sealed" }; } });
  assert.deepEqual(result, { type: "spa_generation_built", id: "fixture", directory: "sealed" }); assert.equal(calls, 1);
  for (const invalid of [["--webpack"], ["--mirror"], ["--restart"], ["--turbopack"]]) assert.throws(() => buildWebOptions(invalid, {}));
  await assert.rejects(buildWeb({ args, build: () => Promise.reject(Error("fixture compile failure")) }), /compile failure/);
});

test("production start cannot select dev, install packages, build or consult owner readiness", async () => {
  const args = ["--mirror", join(ROOT, "../test-build/.spa"), "--port", "32109", "--hostname", "127.0.0.1"];
  const options = productionStartOptions(args, { LEAFCODE_PI_MODE: "dev" }); assert.equal(options.env.LEAFCODE_PI_MODE, "production");
  let invoked = 0;
  const result = await startProductionGateway({ args, env: { LEAFCODE_PI_MODE: "dev" }, launch: async request => {
    invoked++; assert.equal(request.env.LEAFCODE_PI_MODE, "production"); assert.equal(request.env.LEAFCODE_PI_PORT, "32109");
    assert.equal(request.developmentEntry, undefined); assert.equal(request.checkout, ROOT);
    const fake = request.spawn(["sealed-entry.mjs"], { cwd: "sealed", env: {} }); assert.equal(fake, "child"); return "admitted";
  }, spawnChild: (exe, argv, config) => { assert.equal(exe, process.execPath); assert.deepEqual(argv, ["sealed-entry.mjs"]); assert.equal(config.cwd, "sealed"); return "child"; } });
  assert.equal(result, "admitted"); assert.equal(invoked, 1);
  for (const invalid of [["--dev", "true"], ["--port", "0"], ["--port", "65536"], ["--port", "3.5"], ["--hostname"]]) assert.throws(() => productionStartOptions(invalid, {}));
  await assert.rejects(startProductionGateway({ args, launch: () => Promise.reject(Error("No verified build")) }), /No verified build/);
});
