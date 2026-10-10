import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkGatewayRuntimePackage, GATEWAY_HTTP_IMPORTS, runtimeReferences } from "./gateway-runtime-boundary.mjs";
import { buildGateway } from "./build-gateway.mjs";
import { checkGatewayBoundary } from "./production-boundary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const packageSource = join(ROOT, "web/node_modules/undici");
function put(root, name, source) { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gateway-runtime-boundary-")), packageRoot = join(root, "web/node_modules/undici"), links = [];
  t.after(() => { for (const link of links) if (existsSync(link)) unlinkSync(link); rmSync(root, { recursive: true, force: true }); });
  cpSync(packageSource, packageRoot, { recursive: true });
  for (const name of ["@types", "undici-types"]) { const link = join(root, "web/node_modules", name); symlinkSync(join(ROOT, "web/node_modules", name), link, process.platform === "win32" ? "junction" : "dir"); links.push(link); }
  put(root, "gateway/src/index.mjs", 'import "../../web/src/lib/gateway-http.mjs";');
  for (const name of ["gateway-http.mjs", "gateway-http.d.mts"]) { const target = join(root, "web/src/lib", name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(ROOT, "web/src/lib", name), target); }
  put(root, "docs/plans/next-thin-phase0.json", JSON.stringify({ version: 1, groups: { fixture: {} }, routes: [{ route: "/api/fixture", source: "web/src/app/api/fixture/route.ts", group: "fixture", operations: [{ method: "GET", owner: "Backend", phase: 3, decision: "thin-backend-relay", contract: "json", note: "fixture transport" }] }] }));
  put(root, "web/src/app/api/fixture/route.ts", "export function GET() { return Response.json({ ok: true }); }");
  mkdirSync(join(root, "shared"));
  return { root, packageRoot, run: () => checkGatewayRuntimePackage(root, { packageRoot }) };
}

test("locked HTTP closure is explicit; broad root, cache stores and mock implementations are not reachable", () => {
  const result = checkGatewayRuntimePackage(ROOT, { reportFiles: true });
  assert.equal(result.runtimePackageSources, 41);
  assert.equal(result.runtimePackage, "undici@8.10.2");
  assert.ok(!result.runtimePackageFiles.some(file => /cache|mock|index-fetch|^index\.js$/.test(file)));
  assert.ok(!result.runtimePackageBuiltins.some(name => /fs|child_process|module|vm/.test(name)));
  assert.throws(() => checkGatewayRuntimePackage(ROOT, { imports: ["undici"] }), /Unaudited/);
  assert.throws(() => checkGatewayRuntimePackage(ROOT, { imports: ["undici/lib/cache/sqlite-cache-store.js"] }), /Unaudited/);
  assert.equal(GATEWAY_HTTP_IMPORTS.length, 3);
});

test("external CJS, type-only and literal dynamic imports are collected, indirect evaluation is refused", () => {
  assert.deepEqual(runtimeReferences('const x = require("./dep"); import type { X } from "./type"; const lazy = () => import("./lazy");', "fixture.js"), ["./dep", "./lazy", "./type"]);
  for (const source of ['require(process.env.MODULE);', 'const load = require; load("./owner");', 'module["require"]("./owner");', 'eval("hidden");', 'new Function("hidden")();', 'globalThis["ev" + "al"]("hidden");', 'process.getBuiltinModule("fs");', 'new Worker("hidden");', 'new WebAssembly.Module(bytes);', 'const { writeFileSync: write } = require("node:fs");']) {
    assert.throws(() => runtimeReferences(source, "fixture.js"), /loader|require|evaluation|mutation/, source);
  }
});

test("changed direct, dynamic, erased, obfuscated and transitive dependencies fail closed", t => {
  const f = fixture(t), entry = "lib/dispatcher/agent.js", original = readFileSync(join(f.packageRoot, entry), "utf8");
  for (const source of ['require("@earendil-works/pi-coding-agent");', 'import("../../../backend/owner.mjs");', 'import type { Model } from "@earendil-works/pi-ai";', 'Reflect.get(globalThis, "ev" + "al")("hidden");', 'require("../cache/sqlite-cache-store.js");', 'const load = require; load("private");']) {
    put(f.packageRoot, entry, original + "\n" + source); assert.throws(f.run, /changed|loader|require|evaluation/, source);
  }
  put(f.packageRoot, entry, original);
  put(f.packageRoot, "lib/core/util.js", readFileSync(join(f.packageRoot, "lib/core/util.js"), "utf8") + '\nrequire("@backend/store");');
  assert.throws(f.run, /changed/);
});

test("manifest changes, new external dependencies and inner/outer package symlinks are refused", t => {
  const f = fixture(t), pkg = readFileSync(join(f.packageRoot, "package.json"), "utf8");
  put(f.packageRoot, "package.json", JSON.stringify({ ...JSON.parse(pkg), main: "lib/cache/sqlite-cache-store.js" })); assert.throws(f.run, /manifest changed/);
  put(f.packageRoot, "package.json", JSON.stringify({ ...JSON.parse(pkg), dependencies: { "better-sqlite3": "1.0.0" } })); assert.throws(f.run, /manifest changed/);
  put(f.packageRoot, "package.json", pkg);
  const owner = join(f.root, "backend/owner"), victim = join(f.packageRoot, "lib/core/symbols.js"); mkdirSync(owner, { recursive: true });
  const outside = join(owner, "symbols.js"); copyFileSync(victim, outside); unlinkSync(victim); symlinkSync(outside, victim);
  assert.throws(f.run, /symlink escape/);
  unlinkSync(victim); copyFileSync(outside, victim);
  const link = join(f.root, "linked-package"); symlinkSync(f.packageRoot, link, process.platform === "win32" ? "junction" : "dir");
  t.after(() => { if (existsSync(link)) unlinkSync(link); });
  assert.throws(() => checkGatewayRuntimePackage(f.root, { packageRoot: link }), /symlink escape/);
});

test("vendor type-only owner, unresolved external and relative escape cannot hide behind skipLibCheck", t => {
  const f = fixture(t), file = "types/agent.d.ts", original = readFileSync(join(f.packageRoot, file), "utf8");
  for (const source of ['import type { Model } from "@earendil-works/pi-ai";', 'type Hidden = import("@backend/store").Store;', 'import type { Hidden } from "missing-innocent-helper";', 'import type { Hidden } from "../../../backend/owner";']) {
    put(f.packageRoot, file, original + "\n" + source);
    assert.throws(() => checkGatewayBoundary(f.root), /forbidden|unaudited|escape/);
  }
});

test("real route/type gate audits CJS package before build staging even with typecheck disabled", t => {
  const f = fixture(t);
  const result = checkGatewayBoundary(f.root); assert.equal(result.runtimePackageSources, 41);
  put(f.root, "gateway/dist/previous.txt", "immutable previous");
  put(f.packageRoot, "lib/core/util.js", readFileSync(join(f.packageRoot, "lib/core/util.js"), "utf8") + '\nconst load = require;');
  assert.throws(() => buildGateway(f.root, { typecheck: false }), /indirect external require/);
  assert.equal(readFileSync(join(f.root, "gateway/dist/previous.txt"), "utf8"), "immutable previous");
  assert.equal(readdirSync(join(f.root, "gateway")).some(name => /^\.(?:build|previous)-/.test(name)), false);
});
