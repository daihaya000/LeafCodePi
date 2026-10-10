import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkBrowserBoundary, checkGatewayBoundary, checkProductionBoundary, dependencyReferences } from "./production-boundary.mjs";
import { buildGateway } from "./build-gateway.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
function put(root, name, source) { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file; }
function fixture(t, kind) {
  const root = mkdtempSync(join(tmpdir(), `production-${kind}-boundary-`)); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts")); copyFileSync(join(ROOT, "scripts/gateway-contracts.json"), join(root, "scripts/gateway-contracts.json"));
  const entry = kind === "browser" ? "web/src/spa/main.ts" : "gateway/src/index.mjs";
  put(root, entry, "export const fixture = true;");
  put(root, "web/tsconfig.spa.json", JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "es2022"], module: "esnext", moduleResolution: "bundler", allowJs: true, noEmit: true, strict: true, skipLibCheck: true, types: [], baseUrl: ".", paths: { "@/*": ["src/*"], "@shared/*": ["../shared/*"] } }, include: ["src/spa/main.ts"] }));
  put(root, "backend/owner.ts", "export interface Owner { privateStore: true } export const privateStore = new Map();");
  mkdirSync(join(root, "shared"), { recursive: true });
  return { root, entry, run: () => checkProductionBoundary(root, kind, { entries: [join(root, entry)], diagnostics: kind === "browser" }) };
}

test("real Browser value/type closure excludes ambient Node; gateway covers inventoried operations", () => {
  const browser = checkBrowserBoundary(ROOT, { reportFiles: true }), gateway = checkGatewayBoundary(ROOT, { reportFiles: true });
  assert.ok(browser.runtimeSources > 200 && browser.typeSources > 400);
  assert.ok(!browser.typeFiles.some(name => /^(?:backend|host|extensions)\/|web\/src\/app\/api\//.test(name)));
  assert.ok(!browser.runtimeFiles.some(name => name === "shared/tts-backends.ts" || name === "shared/llama-server-settings.mjs" || name === "web/src/lib/host-launch-hints.ts"));
  const inventory = JSON.parse(readFileSync(join(ROOT, "docs/plans/next-thin-phase0.json")));
  assert.equal(gateway.routes, inventory.routes.length); assert.equal(gateway.operations, inventory.routes.reduce((n, route) => n + route.operations.length, 0));
  assert.ok(gateway.runtimeSources > 240 && gateway.typeSources > 450);
});

test("static, erased, mixed and import(type) references are all collected", () => {
  const edges = dependencyReferences('import type { A } from "./a"; export type { B } from "./b"; import { type C, value } from "./c"; type D = import("./d").D; const lazy = () => import("./lazy");');
  assert.deepEqual(edges.map(e => e.specifier), ["./a", "./b", "./c", "./d", "./lazy"]);
});

test("emitted Browser values retain global, alias, reflection and constructor loader refusals", () => {
  for (const source of [
    'Reflect.get(globalThis, "eval")("hidden");', 'Reflect.get(window, "ev" + "al")("hidden");',
    'Reflect.get({}, process.env.KEY)("hidden");', 'Object.getOwnPropertyDescriptor(globalThis, "eval").value("hidden");',
    'globalThis["ev" + "al"]("hidden");', 'const g = globalThis; g["ev" + "al"]("hidden");',
    'let g; g = window; const h = g; Reflect.get(h, "eval")("hidden");',
    'const g = typeof self === "object" ? self : globalThis; g["ev" + "al"]("hidden");',
    'Reflect.get(typeof window === "object" ? window : globalThis, "eval")("hidden");',
    'const { eval: run } = globalThis;', 'const run = (() => {}).constructor; run("hidden");',
    'const run = value.constructor; run("hidden");', 'value.constructor("hidden");',
    'new value.constructor("hidden");', 'const run = value["constr" + "uctor"]; run("hidden");',
    'import(moduleName);', 'const load = require; load("hidden");', 'eval("hidden");',
    'const read = Reflect.get; read(globalThis, "eval")("hidden");',
    'const R = Reflect; const g = globalThis; R.get(g, "eval")("hidden");',
    'const R = globalThis.Reflect; const g = globalThis; R.get(g, key)("hidden");',
    'const read = Object.getOwnPropertyDescriptor; read(globalThis, "eval").value("hidden");',
    'const { getOwnPropertyDescriptor: read } = Object; read(globalThis, "eval").value("hidden");',
    'const key = ["constr", "uctor"].join(""); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), key).value("hidden")();',
    'const read = Object.getOwnPropertyDescriptor; read(Object.getPrototypeOf(() => {}), key).value("hidden")();',
    'const event = () => {}; event.type = ""; event.toString = () => "hidden"; (new event.constructor(event.type, event))();',
    'const cloned = new event.constructor(event.type, event);',
    'const run = value.constructor.prototype.constructor; run("hidden")();',
    'const key = ["constr", "uctor"].join(""); const fn = () => {}; fn[key]("hidden")();',
    'const key = name; const proto = Object.getPrototypeOf(() => {}); const run = proto[key]; run("hidden")();',
    'const key = name; const fn = (() => {}).bind(null); fn[key]("hidden")();',
    'const key = name; Object.getPrototypeOf(Object)[key]("hidden")();',
    'const fn = () => {}; const proto = fn.constructor.prototype; const key = ["constr", "uctor"].join(""); proto[key]("hidden")();',
    'let proto; proto = Object.getPrototypeOf(() => {}); const key = ["constr", "uctor"].join(""); proto[key]("hidden")();',
    'let proto, alias; proto = Object.getPrototypeOf(() => {}); alias = proto; alias[key]("hidden")();',
  ]) assert.throws(() => dependencyReferences(source, "emitted.js", undefined, { kind: "browser", bundled: true }), /loader|loading|evaluation/, source);
  for (const source of [
    'const window = { label: "local" }; Reflect.get(window, "label");',
    'const root = typeof self === "object" ? self : globalThis; root.document;',
    'function focus(w) { w.document.body.focus(); } const target = event.view || window; focus(target);',
    'const ownsFeature = "TextEvent" in window;',
    'Widget.prototype.constructor = Widget;', 'const prototype = value.constructor && value.constructor.prototype;',
    'Object.getOwnPropertyDescriptor(object, "label");',
  ]) assert.doesNotThrow(() => dependencyReferences(source, "emitted.js", undefined, { kind: "browser", bundled: true }), source);
  const clone = 'const root = typeof self === "object" ? self : globalThis; const clone = (key, value) => { switch(key) { case "Function": case "SharedWorker": case "Worker": case "eval": case "setInterval": case "setTimeout": throw new TypeError("unable to deserialize " + key); } return new root[key](value); }; clone("Date", 0);';
  assert.doesNotThrow(() => dependencyReferences(clone, "emitted.js", undefined, { kind: "browser", bundled: true }));
  for (const altered of [clone.replace('case "Function":', ''), clone.replace('case "eval":', ''), clone.replace('throw new TypeError("unable to deserialize " + key)', 'break'), clone.replace('return new root[key](value)', 'const ctor = root[key]; return new ctor(value)')]) {
    assert.throws(() => dependencyReferences(altered, "emitted.js", undefined, { kind: "browser", bundled: true }), /loader/, altered);
  }
});

for (const kind of ["browser", "gateway"]) {
  test(`${kind}: literals, type-only and indirect loaders fail closed`, t => {
    const f = fixture(t, kind);
    for (const source of [
      'import "next/server";', 'export type { NextRequest } from "next/server";',
      'type Hidden = import("@earendil-works/pi-ai").Model;', 'import type { AgentSession } from "@earendil-works/pi-coding-agent";',
      'import "better-sqlite3";', 'import "@backend-core/store";', 'import "@extensions/leafcode-goal-loop";',
      'import(process.env.MODULE);', 'const loader = require; loader("node:fs");', 'const loader = eval; loader("hidden");',
      'globalThis["require"]("node:fs");', 'globalThis["ev" + "al"]("hidden");',
      '(globalThis as any)["ev" + "al"]("hidden");', 'const g = globalThis; g["eval"]("hidden");',
      'const { eval: run } = globalThis;', 'Reflect.get(globalThis, "eval")("hidden");',
      'new Function("return require(\\"node:fs\\")")();', 'const run = (() => {}).constructor; run("hidden")();',
      'process.getBuiltinModule("fs");', 'process.binding("fs");', 'const { constructor: run } = () => {}; run("hidden")();', 'import.meta.glob("../../backend/**");',
      'new Worker(new URL("../../backend/owner.ts", import.meta.url));', 'import "data:text/javascript,export default 1";',
    ]) {
      put(f.root, f.entry, source); assert.throws(f.run, undefined, source);
    }
    for (const source of [
      'import "../../../backend/owner.ts";', 'import type { Owner } from "../../../backend/owner.ts";',
      'type Hidden = import("../../../backend/owner.ts").Owner;', 'export type { Owner } from "../../../backend/owner.ts";',
      'const owner = () => import("../../../backend/owner.ts");',
    ]) {
      const relativeOwner = kind === "gateway" ? source.replaceAll("../../../backend", "../../backend") : source;
      put(f.root, f.entry, relativeOwner); assert.throws(f.run, /forbidden|escaped/, relativeOwner);
    }
  });
  test(`${kind}: transitive type-only owners, triple-slash references and symlink escape are rejected`, t => {
    const f = fixture(t, kind), typeFile = kind === "browser" ? "web/src/spa/types.ts" : "gateway/src/types.ts";
    put(f.root, f.entry, 'import type { Public } from "./types"; export const fixture = true;');
    put(f.root, typeFile, 'export interface Public { ok: true }'); assert.doesNotThrow(f.run);
    const relativeOwner = kind === "browser" ? "../../../backend/owner.ts" : "../../backend/owner.ts";
    for (const source of [`export type { Owner as Public } from "${relativeOwner}";`, `/// <reference path="${relativeOwner}" />\nexport interface Public { ok: true }`]) {
      put(f.root, typeFile, source); assert.throws(f.run, /forbidden|escaped/);
    }
    const link = kind === "browser" ? "web/src/spa/linked" : "gateway/src/linked";
    symlinkSync(join(f.root, "backend"), join(f.root, link), process.platform === "win32" ? "junction" : "dir");
    put(f.root, f.entry, 'import type { Owner } from "./linked/owner";'); assert.throws(f.run, /symlink|forbidden|escaped/);
    put(f.root, f.entry, 'import "./linked/owner";'); assert.throws(f.run, /symlink|forbidden|escaped/);
  });
}

test("Browser rejects Node imports/types through third-party declarations and global references", t => {
  const f = fixture(t, "browser");
  for (const source of ['import "fs/promises";', 'import type { Stats } from "node:fs";', '/// <reference types="node" />\nexport {};', 'export type Platform = NodeJS.Platform;', 'export const platform = process.platform;']) {
    put(f.root, f.entry, source); assert.throws(f.run, /Node/);
  }
  put(f.root, "web/node_modules/browser-helper/package.json", '{"name":"browser-helper","types":"index.d.ts"}');
  put(f.root, f.entry, 'import type { Public } from "browser-helper"; export const fixture = true;');
  put(f.root, "web/node_modules/browser-helper/index.d.ts", 'export interface Public { ok: true }'); assert.doesNotThrow(f.run);
  put(f.root, "web/node_modules/browser-helper/index.d.ts", 'import type { Stats } from "node:fs"; export interface Public { owner: Stats }'); assert.throws(f.run, /Node/);
  put(f.root, "web/node_modules/@earendil-works/pi-ai/package.json", '{"name":"@earendil-works/pi-ai","types":"index.d.ts"}');
  put(f.root, "web/node_modules/@earendil-works/pi-ai/index.d.ts", 'export interface Model { secret: true }');
  put(f.root, "web/node_modules/browser-helper/index.d.ts", 'export type { Model as Public } from "@earendil-works/pi-ai";'); assert.throws(f.run, /forbidden/);
});

test("gateway refuses new shared stores, mutating metadata imports and static snapshot write capabilities", t => {
  const f = fixture(t, "gateway");
  put(f.root, "shared/hidden-store.mjs", 'export const store = new Map(); export const update = value => store.set("business", value);');
  put(f.root, f.entry, 'import "../../shared/hidden-store.mjs";'); assert.throws(f.run, /unaudited/);
  for (const source of ['import type { ChildProcess } from "node:child_process";', 'import { writeFileSync } from "node:fs";']) {
    put(f.root, f.entry, source); assert.throws(f.run, /mutation|capability/);
  }
  put(f.root, f.entry, 'import "../../shared/backend-http-client";');
  put(f.root, "shared/backend-http-client.ts", 'import { readFileSync as read } from "node:fs";'); assert.throws(f.run, /metadata capability/);
  put(f.root, f.entry, 'import "./static.mjs";');
  for (const source of ['import * as fs from "node:fs/promises";', 'import { writeFile } from "node:fs/promises";', 'import { open } from "node:fs/promises"; const file = await open("business", "w"); await file.write("hidden");']) {
    put(f.root, "gateway/src/static.mjs", source); assert.throws(f.run, /read-only|mutation/);
  }
});

test("new gateway gate rejects before legacy compilation and cannot replace existing output", t => {
  const f = fixture(t, "gateway");
  put(f.root, "docs/plans/next-thin-phase0.json", JSON.stringify({ version: 1, groups: { fixture: {} }, routes: [{ route: "/api/fixture", source: "web/src/app/api/fixture/route.ts", group: "fixture", operations: [{ method: "GET", owner: "Backend", phase: 3, decision: "thin-backend-relay", contract: "json", note: "fixture transport" }] }] }));
  put(f.root, "web/src/app/api/fixture/route.ts", 'export function GET() { return Response.json({ ok: true }); }');
  put(f.root, "shared/hidden-store.mjs", 'export const store = new Map();');
  put(f.root, f.entry, 'import "../../shared/hidden-store.mjs";');
  put(f.root, "gateway/dist/previous.txt", "untouched");
  assert.throws(() => buildGateway(f.root, { typecheck: false }), /unaudited/);
  assert.equal(readFileSync(join(f.root, "gateway/dist/previous.txt"), "utf8"), "untouched");
  assert.equal(readdirSync(join(f.root, "gateway")).some(name => name.startsWith(".build-") || name.startsWith(".previous-")), false);
  assert.equal(existsSync(join(f.root, "gateway/dist/manifest.json")), false);
});
