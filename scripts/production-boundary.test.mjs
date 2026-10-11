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
