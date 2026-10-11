import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
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

test("global taint survives local parameters, aliases and returned values without allowing escape", () => {
  for (const source of [
    'const key = name; function invoke(root) { root[key]("hidden"); } invoke(globalThis);',
    'const key = name; function invoke(root) { root[key]("hidden"); } invoke((0, globalThis));',
    'const key = name; function identity(g) { return (0, g); } identity(globalThis)[key]("hidden");',
    'const key = name; function invoke(root) { root[key]("hidden"); } const g = globalThis; invoke(g);',
    'const key = name; function forward(root) { return root; } const g = forward(window); g[key]("hidden");',
    'const key = name; const forward = root => root; const alias = forward; const g = alias(self); g[key]("hidden");',
    'const key = name; let forward; forward = root => root; const g = forward(globalThis); g[key]("hidden");',
    'const key = name; function root() { return globalThis; } root()[key]("hidden");',
    'const key = name; function one(g) { return two(g); } function two(g) { return g; } one(globalThis)[key]("hidden");',
    'const key = name; const g = (root => root)(globalThis); g[key]("hidden");',
    'const key = name; function invoke(g = globalThis) { g[key]("hidden"); } invoke();',
    'const g = globalThis; const holder = {}; holder.root = g;',
    'const g = globalThis; unknown(g);', 'const g = globalThis; holder.invoke(g);',
    'function identity(g) { return g; } function factory() { return g => g[key]("hidden"); } let fn = identity; fn = factory(); fn(globalThis);',
    'function identity(g) { return g; } let fn = identity; fn = unknown; fn(globalThis);',
    'function entry() { invoke(globalThis); } let invoke; invoke = root => root[key]("hidden"); entry();',
    'function focus(g) { g.document; } focus.call(null,globalThis);',
    'function identity(g) { return g; } const bound = identity.bind(null,globalThis); bound().document;',
    'function focus(value,g) { g.document; } const bound = focus.bind(null,1); bound(globalThis);',
    'function focus(g) { g.document; } const bound = focus.bind(null); bound(globalThis);',
    'function focus(g) { g.document; } Object.getPrototypeOf(()=>{}).call = (_,g) => g[key]("hidden"); focus.call(null,globalThis);',
    'function focus(g) { g.document; } Object.defineProperty(focus,"call",{value:(_,g)=>g[key]("hidden")}); focus.call(null,globalThis);',
    'function focus(value,g) { g[key]("hidden"); } const bound = focus.bind(null,1); bound(globalThis);',
    'function focus(value,g) { g.document; } let bound = focus.bind(null,1); bound = unknown; bound(globalThis);',
    'function focus(g) { g.document; } focus.call = (_,g) => g[key]("hidden"); focus.call(null,globalThis);',
    'function focus(g) { g.document; } focus.apply = (_,g) => g[key]("hidden"); focus.apply(null,globalThis);',
    'function focus(g) { g.document; } focus.bind = (_,g) => g[key]("hidden"); focus.bind(null,globalThis);',
    'const g = globalThis; const holder = { root: g };', 'const g = globalThis; const values = [g];',
    'const holder = { root: typeof self === "object" ? self : globalThis };',
    'function invoke(...args) { args[0][key]("hidden"); } invoke(globalThis);',
    'function invoke() { arguments[0][key]("hidden"); } invoke(globalThis);',
    'const g = globalThis; function invoke({ root }) {} invoke({ root: g });',
    'const g = globalThis; const holder = { root() { return g; } };',
    'function outer() { return { root() { return globalThis; } }; }',
  ]) assert.throws(() => dependencyReferences(source, "global-flow.js", undefined, { kind: "browser", bundled: true }), /loader|evaluation/, source);
  for (const source of [
    'function focus(w) { w.document.body.focus(); } focus(window);',
    'const focus = w => w.document.body.focus(); const fn = focus; const root = globalThis; fn(root);',
    'function identity(w) { return w; } const root = identity(window); root.document;',
    'const root = (w => w)(window); root.document;',
    'function getRoot() { return typeof self === "object" ? self : globalThis; } getRoot().document;',
    'const root = globalThis; if (root && root.document) root.document.body.focus();',
    'function inspect(g = globalThis) { return g.document; } inspect();',

    'function identity(g) { return g; } let fn = identity; fn = identity; fn(window).document;',
    'const root = globalThis; const label = "Window: " + root; switch (root) { default: break; }',
    'function entry() { focus(window); } let focus; focus = root => root.document.body.focus(); entry();',
  ]) assert.doesNotThrow(() => dependencyReferences(source, "global-flow.js", undefined, { kind: "browser", bundled: true }), source);
});

test("function and prototype capabilities survive local parameters, defaults, returns and aliases", () => {
  const key = 'const key = ["constr", "uctor"].join(""); ';
  const payload = '"globalThis.canary=true"';
  const probes = [
    `function invoke(fn) { fn[key](${payload})(); } invoke(()=>{});`,
    `function identity(fn) { return fn; } const f = identity(()=>{}); f[key](${payload})();`,
    `function invoke(fn) { fn[key](${payload})(); } invoke.call(null, ()=>{});`,
    `function invoke(fn) { fn[key](${payload})(); } invoke.apply(null, [()=>{}]);`,
    `function invoke(fn) { fn[key](${payload})(); } const bound = invoke.bind(null, ()=>{}); bound();`,
    `function invoke(value, fn) { fn[key](${payload})(); } const bound = invoke.bind(null, 1); bound(()=>{});`,
    `function invoke(a, b, fn) { fn[key](${payload})(); } const bound = invoke.bind(null, 1).bind(null, 2); bound(()=>{});`,
    `function invoke(value, fn) { fn[key](${payload})(); } const bound = invoke.bind(null, 1); bound.call(null, ()=>{});`,
    `function invoke(value, fn) { fn[key](${payload})(); } const bound = invoke.bind(null, 1); bound.apply(null, [()=>{}]);`,
    `function invoke(fn) { fn[key](${payload})(); } invoke(...[()=>{}]);`,
    `function identity(fn) { return fn; } const bound = identity.bind(null, ()=>{}); bound()[key](${payload})();`,
    `function invoke(proto) { proto[key](${payload})(); } invoke(Object.getPrototypeOf(()=>{}));`,
    `const first = Object.getPrototypeOf({})[key]; first[key](${payload})();`,
    `function entry() { invoke(()=>{}); } let invoke; invoke = fn => fn[key](${payload})(); entry();`,
    `function identity(fn) { return fn; } const alias = identity; alias(()=>{})[key](${payload})();`,
    `function one(fn) { return two(fn); } function two(fn) { return fn; } one(()=>{})[key](${payload})();`,
    `function invoke(fn = ()=>{}) { fn[key](${payload})(); } invoke();`,
    `function factory() { return ()=>{}; } factory()[key](${payload})();`,
    `const factory = () => ()=>{}; factory()[key](${payload})();`,
    `class Item {} function invoke(fn) { fn[key](${payload})(); } invoke(Item);`,
    `class Item {} function invoke(proto) { proto[key][key](${payload})(); } invoke(Item.prototype);`,
    `function identity(fn) { return (0, fn); } identity(()=>{})[key](${payload})();`,
    `function identity(fn) { return true ? fn : null; } identity(()=>{})[key](${payload})();`,
    `function identity(fn) { return null || fn; } identity(()=>{})[key](${payload})();`,
    `const fn = ()=>{}; let alias; alias = fn; alias[key](${payload})();`,
    `const fn = ()=>{}; const proto = fn.constructor.prototype; function identity(value) { return value; } identity(proto)[key](${payload})();`,
  ];
  for (const probe of probes) {
    const source = key + probe, context = {};
    vm.runInNewContext(source, context, { timeout: 1000 }); assert.equal(context.canary, true, source);
    for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) {
      assert.throws(() => dependencyReferences(source, "function-flow.js", undefined, { kind, bundled }), /loader|evaluation/, source);
    }
  }
  for (const source of [
    'function invoke(fn) { return fn(); } invoke(()=>1);',
    'function identity(fn) { return fn; } identity(()=>{}).name;',
    'function identity(fn) { return fn; } identity(()=>{})["name"];',
    'const key = "label"; function identity(value) { return value; } identity({label:1})[key];',
    'Object.getPrototypeOf({})["toString"]();',
    'const fn = ()=>{}; fn[0];',
    'class Item {} Item.prototype.label = "data";',
    'function invoke(fn = ()=>1) { return fn(); } invoke();',
    'function invoke(fn) { return fn(); } invoke.call(null, ()=>1);',
    'function invoke(fn) { return fn(); } invoke.apply(null, [()=>1]);',
    'function invoke(fn) { return fn(); } const bound = invoke.bind(null, ()=>1); bound();',
    'function invoke(fn) { return fn(); } invoke(...[()=>1]);',
    'function invoke(fn) { return fn(); } invoke.apply(null);',
    'function invoke(value, fn) { return fn(); } const bound = invoke.bind(null, 1); bound(()=>1);',
  ]) for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) {
    assert.doesNotThrow(() => dependencyReferences(source, "function-flow.js", undefined, { kind, bundled }), source);
  }
});

test("rest and lexical arguments retain indexed capabilities through aliases and local array helpers", () => {
  const key = 'const key = ["constr", "uctor"].join(""); ', payload = '"globalThis.canary=true"';
  const probes = [
    `function invoke(...args) { args[0][key](${payload})(); } invoke(()=>{});`,
    `function invoke() { arguments[0][key](${payload})(); } invoke(()=>{});`,
    `function invoke(value, ...args) { args[0][key](${payload})(); } invoke(0, ()=>{});`,
    `function invoke(value) { arguments[1][key](${payload})(); } invoke(0, ()=>{});`,
    `function invoke(...args) { const alias = args; alias[0][key](${payload})(); } invoke(()=>{});`,
    `function invoke(...args) { let alias; alias = args; alias[0][key](${payload})(); } invoke(()=>{});`,
    `function invoke() { const alias = arguments; alias[0][key](${payload})(); } invoke(()=>{});`,
    `function invoke() { const run = ()=>arguments[0][key](${payload})(); run(); } invoke(()=>{});`,
    `function invoke(fn) { function inner() { arguments[0][key](${payload})(); } inner(fn); } invoke(()=>{});`,
    `const invoke = (...args) => args[0][key](${payload})(); invoke(()=>{});`,
    `function identity(...args) { return args[0]; } identity(()=>{})[key](${payload})();`,
    `function identity() { return arguments[0]; } identity(()=>{})[key](${payload})();`,
    `function invoke(...args) { args["0"][key](${payload})(); } invoke(Object.getPrototypeOf(()=>{}));`,
    `function read(list) { return list[0]; } function invoke(...args) { read(args)[key](${payload})(); } invoke(()=>{});`,
    `function read(list) { return list[0]; } read([()=>{}])[key](${payload})();`,
    `const fn = [()=>{}][0]; fn[key](${payload})();`,
    `function read(list = [()=>{}]) { return list[0]; } read()[key](${payload})();`,
    `function invoke(list = [Object.getPrototypeOf(()=>{})]) { list[0][key](${payload})(); } invoke();`,
    `function invoke(...args) { const index = [0].join(""); args[index][key](${payload})(); } invoke(()=>{});`,
    `function invoke(...args) { args[0][key](${payload})(); } invoke.call(null, ()=>{});`,
    `function invoke(...args) { args[0][key](${payload})(); } invoke.apply(null, [()=>{}]);`,
    `function invoke(value, ...args) { args[0][key](${payload})(); } const bound = invoke.bind(null, 0); bound(()=>{});`,
  ];
  for (const probe of probes) {
    const source = key + probe, context = {};
    vm.runInNewContext(source, context, { timeout: 1000 }); assert.equal(context.canary, true, source);
    for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.throws(() => dependencyReferences(source, "argument-slots.js", undefined, { kind, bundled }), /loader|evaluation/, source);
  }
  for (const source of [
    'function read(...args) { return args[0].label; } read({label:1});',
    'function read() { return arguments[0].label; } read({label:1});',
    'function read(fn, ...args) { const key = "label"; return args[0][key]; } read(()=>{}, {label:1});',
    'function read(fn, ...args) { return args[0].name; } read(()=>{}, {name:"data"});',
    'function read(arguments) { return arguments[0].label; } read([{label:1}]);',
    'function outer(fn) { function inner() { return arguments[0]["label"]; } return inner({label:1}); } outer(()=>{});',
    'function read(list) { return list[0]; } read([{label:1}]).label;',
    'function recurse(...args) { if (false) recurse(args[0]); return args[0]["name"]; } recurse(()=>{});',
    'function empty(...args) { return args[0]; } empty();',
    'function read(list = [{label:1}]) { return list[0].label; } read();',
    'function read(fn, ...args) { const key = "label"; return args[key]; } read(()=>{}, {label:1});',
  ]) for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.doesNotThrow(() => dependencyReferences(source, "argument-slots.js", undefined, { kind, bundled }), source);
  // A positional global can escape through the arguments object even when its
  // declared parameter is never returned. Erasure must not discard that edge.
  for (const source of [
    'function identity(g) { return arguments[0]; } identity(window)[key]("hidden");',
    'function identity(g) { const args = arguments; return args[0]; } identity(window)[key]("hidden");',
    'function identity(g) { const get = ()=>arguments[0]; return get(); } identity(window)[key]("hidden");',
  ]) assert.throws(() => dependencyReferences(source, "argument-slots.js", undefined, { kind: "browser", bundled: true }), /loader|evaluation/, source);
});

test("synthesized computed keys reject plain-object constructor extraction and retain unsafe alternatives", () => {
  const key = 'const key = ["constr", "uctor"].join(""); ', payload = '"globalThis.canary=true"';
  for (const probe of [
    `const data = {}; const first = data[key]; first[key](${payload})();`,
    `let data; data = {}; const first = data[key]; first[key](${payload})();`,
    `const data = {}; const alias = data; const first = alias[key]; first[key](${payload})();`,
    `function read(data) { return data[key]; } read({})[key](${payload})();`,
    `function identity(data) { return data; } identity({})[key][key](${payload})();`,
    `function make() { return {}; } make()[key][key](${payload})();`,
    `function read(data = {}) { return data[key]; } read()[key](${payload})();`,
    `const data = true ? {} : {label:1}; data[key][key](${payload})();`,
    `const data = {} || {label:1}; data[key][key](${payload})();`,
    `const data = (0, {}); data[key][key](${payload})();`,
    `function read(...args) { return args[0][key]; } read({})[key](${payload})();`,
    `function read() { return arguments[0][key]; } read({})[key](${payload})();`,
    `function read() { return this[key]; } read.call({})[key](${payload})();`,
    `const first = {}[key]; let alias; alias = first; alias[key](${payload})();`,
    `function read(data) { return data[key]; } const bound = read.bind(null, {}); bound()[key](${payload})();`,
    `const first = {}[key]; const run = first[key]; run(${payload})();`,
    `const first = {}[key]; const run = first[key]; run.call(null, ${payload})();`,
    `const first = {}[key]; const run = first[key].bind(null); run(${payload})();`,
    `function read() { return {}[key][key]; } read()(${payload})();`,
    `function invoke(run) { run(${payload})(); } invoke({}[key][key]);`,
    `function invoke() { const run = {}[key][key]; new run(${payload})(); } invoke();`,
    `const keyAlias = key; const data = {}; data[keyAlias][keyAlias](${payload})();`,
    `const data = {}; for (var index = 0; index < 1; index++) { index = key; data[index][index](${payload})(); break; }`,
    `const data = {}; function poison() { index = key; } for (var index = 0; index < 1; index++) { poison(); data[index][index](${payload})(); break; }`,
    `const Symbol = {iterator:key}; const token = Symbol.iterator; const data = {}; data[token][token](${payload})();`,
    `const data = {}; const asserted = key as unknown as number; data[asserted][asserted](${payload})();`,
    `const data = {}; const fragment = "constr"; const joined = [fragment,"uctor"].join(""); data[joined][joined](${payload})();`,
    `const data = {}; const joined = ["constr","uctor"].join(); const finalKey = "constr" + "uctor"; data[finalKey][finalKey](${payload})();`,
    `const data = {}; let selected = (()=>"label")(); selected = key; data[selected][selected](${payload})();`,
    `const data = {}; const selected = true ? key : (()=>"label")(); data[selected][selected](${payload})();`,
    `const data = {}; const selected = "" || key; data[selected][selected](${payload})();`,
    `const data = {}; const selected = (0,key); data[selected][selected](${payload})();`,
  ]) {
    const source = key + probe, context = {};
    vm.runInNewContext(source.replace(' as unknown as number', ''), context, { timeout: 1000 }); assert.equal(context.canary, true, source);
    for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.throws(() => dependencyReferences(source, "object-flow.js", undefined, { kind, bundled }), /loader|evaluation/, source);
  }
  for (const source of ['const key=["la","bel"].join(""); Reflect.get({},key);', 'let key="co"; key+="nstructor"; Reflect.get(()=>{},key);']) {
    for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.throws(() => dependencyReferences(source, "object-flow.js", undefined, { kind, bundled }), /loader|reflection|reflected/, source);
  }
  for (const source of [
    'const data = {label:1}; const key = "label"; data[key];',
    'const data = {label:1}; const first = data["label"]; first["name"];',
    'const data = {nested:{label:1}}; const first = data["nested"]; const key = "label"; first[key];',
    'function read(data) { const key = "label"; return data[key]; } read({label:1});',
    'function read(data) { return data["nested"]; } const key = "label"; read({nested:{label:1}})[key];',
    'const data = {label:1}; const key = "label"; data[key] = 2;',
    'const data = {label:1}; const key = "label"; const copy = {[key]:data};',
    'const values = [{label:1}]; values[0]["label"];',
    'const data = {nested:{label:1}}; const firstKey = "nested", secondKey = "label"; const value = data[firstKey][secondKey];',
    'const data = {nested:{label:1}}; const firstKey = "nested", secondKey = "label"; const value = data[firstKey][secondKey]; const read = ()=>value; read();',
    'const data = {nested:[1,2]}; const key = "nested"; data[key][0];',
    'const data = {0:{run:()=>1}}; for (var index=0; index<1; index++) { const first=data[index]; first["run"](); }',
    'const token = Symbol.iterator; const data = {[token]:()=>1}; const first = data[token]; first();',
    'const token = typeof Symbol === "function" && Symbol.iterator; const data = {[token]:()=>1}; const first=data[token]; first();',
  ]) for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.doesNotThrow(() => dependencyReferences(source, "object-flow.js", undefined, { kind, bundled }), source);
});

test("opaque object constructor chains retain refusal states without tainting ordinary callbacks", () => {
  const key='const key=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); ', payload='"globalThis.canary=true"';
  for(const body of [
    `const data={}; const first=data[key]; first[key](${payload})();`,
    `const data=[]; const first=data[key]; first[key](${payload})();`,
    `const data="text"; const first=data[key]; first[key](${payload})();`,
    `const data=1; const first=data[key]; first[key](${payload})();`,
    `let data; data={}; let first; first=data[key]; first[key](${payload})();`,
    `const data={}; const first=data[key]; const run=first[key]; run(${payload})();`,
    `function read(data){return data[key];} read({})[key](${payload})();`,
    `function read(data){const first=data[key];return ()=>first;} read({})()[key](${payload})();`,
    `function make(){return{};} make()[key][key](${payload})();`,
    `function read(data={}){return data[key];} read()[key](${payload})();`,
    `function read(data){return true?data[key]:unknown;} read({})[key](${payload})();`,
    `function read(data){return data[key]||unknown;} read({})[key](${payload})();`,
    `function read(data){return (0,data[key]);} read({})[key](${payload})();`,
    `function read(...args){return args[1][key];} read(0,{})[key](${payload})();`,
    `function read(){return arguments[1][key];} read(0,{})[key](${payload})();`,
    `function read(){return this[key];} read.call({})[key](${payload})();`,
    `function read(){return this[key];} read.apply({},[])[key](${payload})();`,
    `function read(){return this[key];} read.bind({})()[key](${payload})();`,
    `function read(data){return data[key];} const readBound=read.bind(null,{}); readBound()[key](${payload})();`,
    `const first={}[key]; first[key].call(null,${payload})();`,
    `const first={}[key]; first[key].apply(null,[${payload}])();`,
    `const first={}[key]; const run=first[key].bind(null,${payload}); run()();`,
    `const key2=String.fromCodePoint(99,111,110,115,116,114,117,99,116,111,114); const first2={}[key2]; first2[key2](${payload})();`,
    `const key3=["constr","uctor"].join(""); const first3={}[key3]; first3[key3](${payload})();`,
    `const key4="constructor".slice(0); const first4={}[key4]; first4[key4](${payload})();`,
    `const key5=decodeURIComponent("constructor"); const first5={}[key5]; first5[key5](${payload})();`,
    `const codes6=[99,111,110,115,116,114,117,99,116,111,114]; const key6=String.fromCharCode(...codes6); const first6={}[key6]; first6[key6](${payload})();`,
    `const key7=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114+0); const first7={}[key7]; first7[key7](${payload})();`,
    `function read8(){return{}}; const first8=read8()[String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114)]; first8[String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114)](${payload})();`,
    `const key9="constructor".substring(0,11); const first9={}[key9]; first9[key9](${payload})();`,
  ]) {
    const source=key+body,context={};vm.runInNewContext(source,context,{timeout:1000});assert.equal(context.canary,true,source);
    for(const kind of ["browser","gateway"])for(const bundled of [false,true])assert.throws(()=>dependencyReferences(source,"object-constructor.js",undefined,{kind,bundled}),/loader|evaluation/,source);
  }
  for(const source of [
    'const key=unknown; const data={}; const value=data[key];',
    'const key=unknown; const registry={}; registry[key]();',
    'const key=unknown; const registry={}; registry[key].call(null,1);',
    'const key=unknown; const registry={}; const fn=registry[key]; fn.name;',
    'const group="label",field="item"; const data={label:{item:()=>1}}; data[group][field]();',
    'const data=[[()=>1]]; data[0][0]();',
    'function read(data,key){return data[key];} read({label:1},"label");',
    'function read(data,key){return data[key];} const data={label:{run:()=>1}}; read(data,"label")["run"]();',
    'function make(){return{};} make()[unknown];',
    'const key=unknown; const first={}[key]; first["name"];',
    'const key=unknown; const first={}[key]; first.bind(null)(1);',
    'const key=unknown; const first={}[key]; first.call(null,1);',
    'const codes=[1,2,3]; const key=String.fromCharCode(...codes); const data={}; data[key];',
    'const key=String.fromCharCode(97,98,99); const data={}; data[key];',
    'const key="abc".slice(0); const data={}; data[key];',
    'const key=decodeURIComponent(atob("YWJj")); const data={}; data[key];',
    'const key=["a","b"].join(""); const data={}; data[key];',
    'const fn={constructor:null}; const key=fn.name; fn[key];',
  ]) for(const kind of ["browser","gateway"])for(const bundled of [false,true])assert.doesNotThrow(()=>dependencyReferences(source,"object-constructor.js",undefined,{kind,bundled}),source);
});

test("synthesized constructor keys from string, array and record decoding stay refused", () => {
  const payload = '"globalThis.canary=true"', tail = 'const data={}; const first=data[key]; first[key](' + payload + ')();';
  const negatives = [
    'const key=String.fromCharCode.apply(null,[99,111,110,115,116,114,117,99,116,111,114]); ',
    'const key="constr".concat("uctor"); ',
    'const key=`constr${"uctor"}`; ',
    'const key="constructoX".replace("X","r"); ',
    'const key="Xconstructor".replaceAll("X",""); ',
    'const key="constr,uctor".split(",").join(""); ',
    'const key=Array.from("constructor").join(""); ',
    'const key=[..."constructor"].join(""); ',
    'const key="constructor".padEnd(11); ',
    'const key="CONSTRUCTOR".toLowerCase(); ',
    'const key=" constructor".trimStart(); ',
    'const key=String.raw`constructor`; ',
    'const key=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114+0); ',
    'const key="constructor".slice(0,11); ',
    'const key=decodeURIComponent("construc%74or"); ',
    'const key=unescape("constructor"); ',
    'const key=JSON.parse("\\"constructor\\""); ',
    'const key=new String("constructor").valueOf(); ',
    'const key=Object.keys({constructor:1})[0]; ',
    'const key=Reflect.ownKeys({constructor:1})[0]; ',
    'function f(){return "constructor";} const key=f(); ',
    'function f(a,b){return a+b;} const key=f("constr","uctor"); ',
    'const f=()=>"constructor"; const key=f(); ',
    'const key=(function(){return ["constr","uctor"].join("");})(); ',
    'const [key]=["constructor"]; ',
    'const {k:key}={k:"constructor"}; ',
    'const key=Object.fromEntries([["k","constructor"]]).k; ',
    'const key=["constructor"][0]; ',
    'const key="constructor".charAt(0)+"constructor".substring(1); ',
  ];
  for (const builder of negatives) {
    const source = builder + tail, context = {};
    vm.runInNewContext(source, context, { timeout: 1000 }); assert.equal(context.canary, true, source);
    for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.throws(() => dependencyReferences(source, "key-decode.js", undefined, { kind, bundled }), /loader|evaluation/, source);
  }
  const positives = [
    'const key=String.fromCharCode(97,98,99); const data={}; data[key];',
    'const key="abc".concat("def"); const data={}; data[key];',
    'const key=`ab${"c"}`; const data={}; data[key];',
    'const key="aXb".replace("X",""); const data={}; data[key];',
    'const key="a,b".split(",").join(""); const data={}; data[key];',
    'const key=Array.from("abc").join(""); const data={}; data[key];',
    'const key=[..."abc"].join(""); const data={}; data[key];',
    'const key="AB".toLowerCase(); const data={}; data[key];',
    'const key=" ab ".trimStart(); const data={}; data[key];',
    'function f(a,b){return a+b;} const key=f("a","b"); const data={}; data[key];',
    'const [key]=["a","b"]; const data={}; data[key];',
    'const {k:key}={k:"a"}; const data={}; data[key];',
    'const key=Object.fromEntries([["k","a"]]).k; const data={}; data[key];',
    'const key=Object.keys({ab:1})[0]; const data={}; data[key];',
    'const key=JSON.parse("\\"ab\\""); const data={}; data[key];',
    'const key=new String("ab").valueOf(); const data={}; data[key];',
    'const key="abcdef".substring(0,2); const data={}; data[key];',
    'const key=String.fromCharCode(99,111); const data={constructor:1}; data[key];',
    'const String={fromCharCode:()=>"constructor"}; const key=String.fromCharCode(99); const data={}; data[key];',
    'const key=String.fromCharCode(97,98,99); const data=[[()=>1]]; data[key][0];',
    'const key=String.fromCharCode(97,98,99); const fn={constructor:null}; fn[key];',
  ];
  for (const source of positives) for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.doesNotThrow(() => dependencyReferences(source, "key-decode.js", undefined, { kind, bundled }), source);
});

test("returned function invocation targets retain capabilities, bindings and unknown alternatives", () => {
  const key = 'const key=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); ', payload = '"globalThis.canary=true"';
  for (const probe of [
    `function make(fn){return ()=>fn;} make(()=>{})()[key](${payload})();`,
    `function make(){return fn=>fn[key](${payload})();} make()(()=>{});`,
    `function make(){return fn=>fn[key](${payload})();} const run=make(); run(()=>{});`,
    `function make(){return fn=>fn[key](${payload})();} let run; run=make(); run(()=>{});`,
    `function outer(){return ()=>fn=>fn[key](${payload})();} outer()()(()=>{});`,
    `function make(fn){return fn;} make(fn=>fn[key](${payload})())(()=>{});`,
    `function make(fn=arg=>arg[key](${payload})()){return fn;} make()(()=>{});`,
    `function make(){return function(){this[key](${payload})();};} make().call(()=>{});`,
    `function make(){return function(){this[key](${payload})();};} make().apply(()=>{}, []);`,
    `function make(){return function(){this[key](${payload})();};} make().bind(()=>{})();`,
    `function make(fn){return ()=>this;} make.call(()=>{})()[key](${payload})();`,
    `function make(){return (prefix,fn)=>fn[key](${payload})();} make().bind(null,0)(()=>{});`,
    `function make(){return (a,b,fn)=>fn[key](${payload})();} make().bind(null,0).bind(null,1)(()=>{});`,
    `function make(){function run(prefix,fn){fn[key](${payload})();} return run.bind(null,0);} make()(()=>{});`,
    `function make(){return (...args)=>args[1][key](${payload})();} make()(0,()=>{});`,
    `function make(){return function(){arguments[1][key](${payload})();};} make().apply(null,[0,()=>{}]);`,
    `function make(){const run=fn=>fn[key](${payload})(); return true?run:unknown;} make()(()=>{});`,
    `function make(){const run=fn=>fn[key](${payload})(); return run||unknown;} make()(()=>{});`,
    `function make(){const run=fn=>fn[key](${payload})(); return (0,run);} make()(()=>{});`,
    `function identity(fn){return fn;} function make(){return identity(fn=>fn[key](${payload})());} make()(()=>{});`,
  ]) {
    const source=key+probe, context={}; vm.runInNewContext(source,context,{timeout:1000}); assert.equal(context.canary,true,source);
    for(const kind of ["browser","gateway"]) for(const bundled of [false,true]) assert.throws(()=>dependencyReferences(source,"returned-functions.js",undefined,{kind,bundled}),/loader|evaluation/,source);
  }
  for(const source of [
    'function make(){return value=>value+1;} make()(1);',
    'function make(fn){return fn;} make(value=>value+1)(1);',
    'function outer(){return ()=>value=>value+1;} outer()()(1);',
    'function make(){return function(){return this.label;};} make().call({label:1});',
    'function make(){return (prefix,value)=>prefix+value;} make().bind(null,1)(2);',
    'function make(){return (a,b,value)=>a+b+value;} make().bind(null,1).bind(null,2)(3);',
    'function make(){return (...args)=>args[1];} make()(0,1);',
    'function make(){const run=value=>value; return true?run:unknown;} make()(1);',
    'function make(){return value=>value;} const run=make(); let alias; alias=run; alias(1);',
  ]) for(const kind of ["browser","gateway"]) for(const bundled of [false,true]) assert.doesNotThrow(()=>dependencyReferences(source,"returned-functions.js",undefined,{kind,bundled}),source);
  for(const source of [
    'function make(){return root=>root.document;} make()(globalThis);',
    'function use(run){run(globalThis);} use(root=>root.document);',
    'function make(){return true?root=>root.document:unknown;} make()(globalThis);',
    'function use(run=root=>root.document){run(globalThis);} use();',
  ]) assert.throws(()=>dependencyReferences(source,"returned-functions.js",undefined,{kind:"browser",bundled:true}),/global|loader/,source);
  assert.throws(()=>dependencyReferences('function target(){} function make(flag){return flag?target:make().bind(null,1);} make();',"recursive-return.js"),/function target analysis forbidden/);
  const diamond = Array.from({length:28},(_,index)=>`const f${index+1}=true?f${index}:f${index};`).join('');
  const denseUnsafe=key+`const f0=fn=>fn[key](${payload})();`+diamond+'function identity(fn){return fn;} identity(f28)(()=>{});';
  const denseSafe='const f0=value=>value;'+diamond+'function identity(fn){return fn;} identity(f28)(1);';
  for(const kind of ["browser","gateway"]) for(const bundled of [false,true]) {
    assert.throws(()=>dependencyReferences(denseUnsafe,"dense-return.js",undefined,{kind,bundled}),/loader|evaluation/);
    assert.doesNotThrow(()=>dependencyReferences(denseSafe,"dense-return.js",undefined,{kind,bundled}));
  }
});

test("explicit this receivers retain capabilities through wrappers, binding and lexical arrows", () => {
  const key = 'const key = ["constr", "uctor"].join(""); ', payload = '"globalThis.canary=true"';
  const invoke = `function invoke() { this[key](${payload})(); } `;
  const probes = [
    invoke + 'invoke.call(()=>{});',
    invoke + 'invoke.apply(()=>{}, []);',
    invoke + 'const bound = invoke.bind(()=>{}); bound();',
    invoke + 'invoke.call(Object.getPrototypeOf(()=>{}));',
    invoke + 'let alias; alias = invoke; alias.call(()=>{});',
    invoke + 'const alias = invoke; alias.apply(()=>{}, []);',
    invoke + 'const bound = invoke.bind(()=>{}).bind({label:1}); bound();',
    invoke + 'const bound = invoke.bind(()=>{}); bound.call({label:1});',
    invoke + 'const bound = invoke.bind(()=>{}); bound.apply({label:1}, []);',
    `function identity() { return this; } identity.call(()=>{})[key](${payload})();`,
    `function identity() { return this; } const bound = identity.bind(()=>{}); bound()[key](${payload})();`,
    `function invoke() { const alias = this; alias[key](${payload})(); } invoke.call(()=>{});`,
    `function invoke() { let alias; alias = this; alias[key](${payload})(); } invoke.call(()=>{});`,
    `function invoke() { const run = ()=>this[key](${payload})(); run.call({label:1}); } invoke.call(()=>{});`,
    `function invoke() { const identity = ()=>this; identity()[key](${payload})(); } invoke.apply(()=>{}, []);`,
    `function invoke() { function inner() { this[key](${payload})(); } inner.call(this); } invoke.call(()=>{});`,
    `function invoke(fn) { const forward = ()=>invoke.call(this); if (fn) forward(); else this[key](${payload})(); } invoke.call(()=>{}, false);`,
    `function invoke() { this[key](${payload})(); } function entry() { invoke.call(()=>{}); } entry();`,
  ];
  for (const probe of probes) {
    const source = key + probe, context = {};
    vm.runInNewContext(source, context, { timeout: 1000 }); assert.equal(context.canary, true, source);
    for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.throws(() => dependencyReferences(source, "this-flow.js", undefined, { kind, bundled }), /loader|evaluation/, source);
  }
  for (const source of [
    'function read() { const key = "label"; return this[key]; } read.call({label:1});',
    'function read() { return this.label; } read.apply({label:1}, []);',
    'function read() { const key = "label"; return this[key]; } const bound = read.bind({label:1}); bound.call(()=>{});',
    'function read() { const key = "label"; return this[key]; } const bound = read.bind({label:1}).bind(()=>{}); bound();',
    'function outer() { const read = ()=>this["label"]; return read.call(()=>{}); } outer.call({label:1});',
    'function outer() { const key = "label"; const read = ()=>this[key]; return read.bind(()=>{})(); } outer.call({label:1});',
    'function outer() { function inner() { const key = "label"; return this[key]; } return inner.call({label:1}); } outer.call(()=>{});',
    'function read(fn) { return this.label + fn(); } read.call({label:1}, ()=>2);',
    'function read() { const key = "label"; return this[key]; } const bound = read.bind(); bound.call(()=>{});',
  ]) for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.doesNotThrow(() => dependencyReferences(source, "this-flow.js", undefined, { kind, bundled }), source);
  for (const source of [
    'function invoke() { this[key]("hidden"); } invoke.call(window);',
    'function forward(g) { invoke.call(g); } function invoke() { this[key]("hidden"); } forward(window);',
    'function forward(g) { invoke.apply(g, []); } function invoke() { const alias = this; alias[key]("hidden"); } forward(window);',
    'function forward(g) { const bound = identity.bind(g); return bound(); } function identity() { return this; } forward(window)[key]("hidden");',
  ]) assert.throws(() => dependencyReferences(key + source, "this-global.js", undefined, { kind: "browser", bundled: true }), /loader|evaluation/, source);
});

test("nonliteral variadic forwarding retains capability alternatives without granting global escape", () => {
  const key = 'const key = ["constr", "uctor"].join(""); ', payload = '"globalThis.canary=true"';
  const sink = `function sink(fn) { fn[key](${payload})(); } `;
  const probes = [
    `${sink}function forward(...args) { sink(...args); } forward(()=>{});`,
    `${sink}function forward() { sink(...arguments); } forward(()=>{});`,
    `${sink}function forward() { sink.apply(null, arguments); } forward(()=>{});`,
    `${sink}const list = [()=>{}]; sink(...list);`,
    `${sink}const list = [()=>{}]; sink.apply(null, list);`,
    `${sink}function forward(...args) { const alias = args; sink(...alias); } forward(Object.getPrototypeOf(()=>{}));`,
    `${sink}function forward(...args) { let alias; alias = args; sink(...alias); } forward(()=>{});`,
    `${sink}function forward() { const run = ()=>sink(...arguments); run(); } forward(()=>{});`,
    `${sink}function forward(...args) { sink(...[...args]); } forward(()=>{});`,
    `${sink}function forward(...args) { const list = [...args]; sink(...list); } forward(()=>{});`,
    `function sink(first, fn) { fn[key](${payload})(); } function forward(...args) { sink(0, ...args); } forward(()=>{});`,
    `function sink(first, fn) { fn[key](${payload})(); } function forward(...args) { sink(...args, ()=>{}); } forward(0);`,
    `function sink(first, fn) { fn[key](${payload})(); } function forward(...args) { const bound = sink.bind(null, 0); bound(...args); } forward(()=>{});`,
    `function sink(first, fn) { fn[key](${payload})(); } function forward(...args) { const bound = sink.bind(null, ...args); bound(()=>{}); } forward(0);`,
    `function sink(first, ...rest) { rest[1][key](${payload})(); } function forward(...args) { sink(...args); } forward(0, 1, ()=>{});`,
    `function sink() { arguments[2][key](${payload})(); } function forward(...args) { sink(...args); } forward(0, 1, ()=>{});`,
    `function identity(fn) { return fn; } function forward(...args) { return identity(...args); } forward(()=>{})[key](${payload})();`,
    `function sink(fn) { fn[key](${payload})(); } function middle(...args) { sink(...args); } function forward(...args) { middle.apply(null, args); } forward(()=>{});`,
    `${sink}function forward(...args) { const list = true ? args : []; sink(...list); } forward(()=>{});`,
    `${sink}function forward(...args) { const list = args || []; sink(...list); } forward(()=>{});`,
  ];
  for (const probe of probes) {
    const source = key + probe, context = {};
    vm.runInNewContext(source, context, { timeout: 1000 }); assert.equal(context.canary, true, source);
    for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.throws(() => dependencyReferences(source, "variadic-flow.js", undefined, { kind, bundled }), /loader|evaluation/, source);
  }
  for (const source of [
    'function sink(fn) { fn(); } function forward(...args) { sink(...args); } forward(()=>{});',
    'function sink(data) { return data["label"]; } function forward(...args) { sink(...args); } forward({label:1});',
    'function sink(first, data) { return data["label"]; } function forward(fn, ...args) { sink(0, ...args); } forward(()=>{}, {label:1});',
    'function sink(fn, ...data) { return data[0]["label"]; } function forward(...args) { sink(...args); } forward(()=>{}, {label:1});',
    'function sink(data) { return data["label"]; } const values = [{label:1}]; sink.apply(null, values);',
    'function sink(data) { return data["label"]; } function forward() { return sink(...arguments); } forward({label:1});',
    'function sink(data) { return data["label"]; } function forward(fn) { function inner() { return sink(...arguments); } return inner({label:1}); } forward(()=>{});',
    'function sink(data) { return data["label"]; } function forward(arguments) { return sink(...arguments); } forward([{label:1}]);',
    'function sink(fn, data) { fn(); return data.label; } const a = [()=>{}]; sink(...a, {label:1});',
  ]) for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) assert.doesNotThrow(() => dependencyReferences(source, "variadic-flow.js", undefined, { kind, bundled }), source);
  for (const source of [
    'function sink(g) { return typeof g; } const values = []; sink(window, ...values);',
    'function sink(first, g) { return typeof g; } const values = []; sink(...values, window);',
    'function forward(g) { sink(...arguments); } function sink(root) { root[key]("hidden"); } forward(window);',
    'function forward(g) { sink.apply(null, arguments); } function sink(root) { root[key]("hidden"); } forward(window);',
  ]) assert.throws(() => dependencyReferences(key + source, "variadic-global.js", undefined, { kind: "browser", bundled: true }), /loader|evaluation/, source);
});

test("argument-container traversal retains dense alias alternatives without exponential path enumeration", () => {
  for (const value of ['()=>{}', '{label:1}']) {
    let source = `const root = [${value}];`, previous = "root";
    for (let index = 0; index < 28; index++) {
      source += `const left${index} = ${previous}; const right${index} = ${previous}; const joined${index} = true ? left${index} : right${index};`;
      previous = `joined${index}`;
    }
    source += `const receiver = ${previous}[0];`;
    source += value === '()=>{}' ? 'const key = ["constr", "uctor"].join(""); receiver[key]("hidden")();' : 'receiver.label;';
    const started = performance.now();
    for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) {
      const check = () => dependencyReferences(source, "dense-argument-aliases.js", undefined, { kind, bundled });
      if (value === '()=>{}') assert.throws(check, /loader|evaluation/); else assert.doesNotThrow(check);
    }
    assert.ok(performance.now() - started < 5000, "dense argument aliases exceeded bounded traversal time");
  }
});

test("Browser and gateway value-closure gates reject local function capabilities before compilation", t => {
  for (const kind of ["browser", "gateway"]) for (const body of [
    'function invoke(fn) { fn[key]("hidden")(); } invoke(()=>{});',
    'function identity(fn) { return fn; } identity(()=>{})[key]("hidden")();',
    'function invoke(proto) { proto[key]("hidden")(); } invoke(Object.getPrototypeOf(()=>{}));',
    'Object.getPrototypeOf({})[key][key]("hidden")();',
    'function entry() { invoke(()=>{}); } let invoke; invoke = fn => fn[key]("hidden")(); entry();',
    'function invoke(...args) { args[0][key]("hidden")(); } invoke(()=>{});',
    'function invoke() { arguments[0][key]("hidden")(); } invoke(()=>{});',
    'function read(list) { return list[0]; } function invoke(...args) { read(args)[key]("hidden")(); } invoke(()=>{});',
    'function invoke(...args) { sink(...args); } function sink(fn) { fn[key]("hidden")(); } invoke(()=>{});',
    'function invoke() { sink.apply(null, arguments); } function sink(fn) { fn[key]("hidden")(); } invoke(()=>{});',
    'const list = [()=>{}]; function sink(fn) { fn[key]("hidden")(); } sink(...list);',
    'function invoke() { this[key]("hidden")(); } invoke.call(()=>{});',
    'function invoke() { this[key]("hidden")(); } invoke.apply(()=>{}, []);',
    'function invoke() { this[key]("hidden")(); } const bound = invoke.bind(()=>{}); bound();',
    'const data = {}; const first = data[key]; first[key]("hidden")();',
    'function read(data) { return data[key]; } read({})[key]("hidden")();',
    'function make() { return {}; } make()[key][key]("hidden")();',
    'const opaque=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); const data={}; const first=data[opaque]; first[opaque]("hidden")();',
    'const opaque=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); function read(data){const first=data[opaque];return ()=>first;} read({})()[opaque]("hidden")();',
    'const opaque=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); function make() { return fn=>fn[opaque]("hidden")(); } make()(()=>{});',
    'const opaque=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); function make() { return function(){this[opaque]("hidden")();}; } make().call(()=>{});',
  ]) {
    const f = fixture(t, kind);
    const helper = kind === "browser" ? "shared/function-flow.mjs" : "gateway/src/function-flow.mjs";
    put(f.root, f.entry, kind === "browser" ? 'import "../../../shared/function-flow.mjs";' : 'import "./function-flow.mjs";');
    put(f.root, helper, 'const key = ["constr", "uctor"].join(""); ' + body);
    assert.throws(f.run, /loader.*forbidden/, `${kind}: ${body}`);
    if (kind === "gateway") {
      put(f.root, "docs/plans/next-thin-phase0.json", JSON.stringify({ version: 1, groups: { fixture: {} }, routes: [{ route: "/api/fixture", source: "web/src/app/api/fixture/route.ts", group: "fixture", operations: [{ method: "GET", owner: "Backend", phase: 3, decision: "thin-backend-relay", contract: "json", note: "fixture transport" }] }] }));
      put(f.root, "web/src/app/api/fixture/route.ts", 'export function GET() { return Response.json({ ok: true }); }');
      assert.throws(() => buildGateway(f.root, { typecheck: false }), /loader.*forbidden/, body);
      assert.equal(existsSync(join(f.root, "gateway/dist")), false);
    }
  }
});

test("destructuring cannot extract constructors or untracked reflection loaders", () => {
  const probes = [
    'const key = ["constr", "uctor"].join(""); const { [key]: run } = () => {}; run("hidden")();',
    'const key = name; const { [key]: run } = Object.getPrototypeOf(() => {}); run("hidden")();',
    'const { ["constr" + "uctor"]: run } = () => {}; run("hidden")();',
    'const { "constructor": run } = () => {}; run("hidden")();',
    'function extract({ [key]: run }) { return run("hidden")(); }',
    'const { nested: { [key]: run } } = holder;',
    'let run; ({ [key]: run } = () => {}); run("hidden")();',
    'let run; ({ constructor: run } = () => {}); run("hidden")();',
    'let run; ({ "constructor": run } = () => {}); run("hidden")();',
    'let run; ([{ nested: { [key]: run } }] = holder);',
    'let constructor; ({ constructor } = () => {});',
    'let run; for ({ [key]: run } of [() => {}]) run("hidden")();',
    'let run; for ({ constructor: run } of [() => {}]) run("hidden")();',
    'let run; for ({ [key]: run } in data) {}',
    'async function extract() { let run; for await ({ [key]: run } of values) run("hidden")(); }',
    'const { ["getOwnPropertyDescriptor"]: read } = Object; read(value, key).value("hidden")();',
    'const { "getOwnPropertyDescriptor": read } = Object; read(value, key).value("hidden")();',
    'let read; ({ getOwnPropertyDescriptor: read } = Object); read(value, key).value("hidden")();',
    'const { get: read } = globalThis.Reflect; read(value, key)("hidden")();',
  ];
  for (const kind of ["browser", "gateway"]) for (const bundled of [false, true]) {
    for (const source of probes) assert.throws(() => dependencyReferences(source, "destructuring.js", undefined, { kind, bundled }), /loader|evaluation/, source);
    for (const source of [
      'const { label, "count": count, ["na" + "me"]: name } = data;',
      'const { [0]: first } = values;',
      'let label; ({ label } = data);',
      'const values = { [key]: value };',
      'function show({ label }) { return label; }',
      'let label; for ({ label } of values) show(label);',
    ]) assert.doesNotThrow(() => dependencyReferences(source, "destructuring.js", undefined, { kind, bundled }), source);
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
      'const key = ["constr", "uctor"].join(""); const { [key]: run } = () => {}; run("hidden")();',
      'let run; ({ ["constr" + "uctor"]: run } = () => {}); run("hidden")();',
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
