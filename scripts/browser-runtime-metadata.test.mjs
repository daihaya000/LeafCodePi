import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { browserMetadataVerifier, browserSourceWithoutMapDirectives } from "./browser-runtime-metadata.mjs";
import { dependencyReferences } from "./production-boundary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url))), require = createRequire(resolve(ROOT, "web/package.json")), ts = require("typescript");
const file = "react-dom/cjs/react-dom-client.production.js", content = readFileSync(resolve(ROOT, "web/node_modules", file), "utf8");
function mapped(code, site, { source = "../../node_modules/" + file, bytes = content } = {}) {
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true), position = content.indexOf(site), original = ast.getLineAndCharacterOfPosition(position);
  assert.ok(position >= 0);
  return { fileName: "emitted.js", code, map: { version: 3, names: [], sources: [source], sourcesContent: [bytes], mappings: [[[0, 0, original.line, original.character]]] } };
}
function check(chunk) { return dependencyReferences(chunk.code, chunk.fileName, ts, { kind: "browser", bundled: true, allowMetadata: browserMetadataVerifier(chunk, ts) }); }

test("metadata requires byte-pinned compiler origin, not just an Event or descriptor shape", () => {
  const event = mapped("new e.constructor(e.type, e);", "nextBlockedOn.constructor("), descriptor = mapped("Object.getOwnPropertyDescriptor(o, key);", "Object.getOwnPropertyDescriptor(\n      node.constructor.prototype");
  assert.doesNotThrow(() => check(event)); assert.doesNotThrow(() => check(descriptor));
  for (const chunk of [event, descriptor]) {
    assert.throws(() => check({ ...chunk, map: null }), /source map required/);
    assert.throws(() => check({ ...chunk, map: { ...chunk.map, sourcesContent: [content + "\n// drift"] } }), /source changed/);
    for (const source of ["../../node_modules/next-themes/dist/index.mjs", "../../src/spa/copied-react.js"]) assert.throws(() => check({ ...chunk, map: { ...chunk.map, sources: [source] } }), /loader|evaluation/);
    assert.throws(() => check({ ...chunk, map: { ...chunk.map, mappings: [[]] } }), /loader|evaluation/);
  }
  assert.throws(() => check(mapped(event.code, "var nextBlockedOn = findInstanceBlockingEvent")), /evaluation/);
});

test("React global transport, private reads and cache gets require byte-pinned compiler provenance", () => {
  for (const chunk of [
    mapped('const root = globalThis; const event = { target: root };', 'this.target = nativeEventTarget;'),
    mapped('const root = globalThis; root[slot];', 'nativeEventTarget[internalPropsKey]'),
    mapped('const root = globalThis; cache.get(root);', 'CapturedStacks.get(value)'),
  ]) {
    assert.doesNotThrow(() => check(chunk));
    assert.throws(() => check({ ...chunk, map: null }), /source map required/);
    assert.throws(() => check({ ...chunk, map: { ...chunk.map, sourcesContent: [content + "\n// drift"] } }), /source changed/);
    for (const source of ["../../node_modules/next-themes/dist/index.mjs", "../../src/spa/copied-react.js"]) {
      assert.throws(() => check({ ...chunk, map: { ...chunk.map, sources: [source] } }), /loader|evaluation/);
    }
  }
  for (const code of ['const root = globalThis; Reflect.get(root, "eval")("hidden");', 'const root = globalThis; root["eval"]("hidden");', 'new Function("hidden")();']) {
    assert.throws(() => check(mapped(code, 'CapturedStacks.get(value)')), /loader|evaluation/);
  }
});

test("unist and unified function reads require three exact byte-pinned compiler sites", () => {
  for (const [name, site] of [["unist-util-is/lib/index.js", "tests[index]"], ["unist-util-is/lib/index.js", "checkAsRecord[key]"], ["unified/lib/callable-instance.js", "proto[property]"]]) {
    const bytes = readFileSync(resolve(ROOT, "web/node_modules", name), "utf8"), ast = ts.createSourceFile(name, bytes, ts.ScriptTarget.Latest, true);
    const position = ast.getLineAndCharacterOfPosition(bytes.indexOf(site));
    const chunk = { fileName: "emitted.js", code: 'const fn = ()=>{}; fn[slot];', map: { version: 3, names: [], sources: ["../../node_modules/" + name], sourcesContent: [bytes], mappings: [[[0, 0, position.line, position.character]]] } };
    assert.doesNotThrow(() => check(chunk));
    assert.throws(() => check({ ...chunk, map: null }), /source map required/);
    assert.throws(() => check({ ...chunk, map: { ...chunk.map, sourcesContent: [bytes + "\n// drift"] } }), /source changed/);
    assert.throws(() => check({ ...chunk, map: { ...chunk.map, sources: ["../../node_modules/next-themes/dist/index.mjs"] } }), /loader/);
    assert.throws(() => check({ ...chunk, map: { ...chunk.map, mappings: [[]] } }), /loader/);
    assert.throws(() => check({ ...chunk, map: { ...chunk.map, mappings: [[[0, 0, 0, 0]]] } }), /loader/);
    for (const code of ['const fn = ()=>{}; fn["constructor"]("hidden")();', 'const root = globalThis; root[slot];']) assert.throws(() => check({ ...chunk, code }), /loader|evaluation/);
    assert.equal(browserSourceWithoutMapDirectives(bytes, name, ts), bytes);
  }
});

test("upstream inline/external maps cannot forge compiler identity; comment stripping preserves strings and offsets", () => {
  const directives = ["//# sourceMappingURL=spoof.map", "//@ sourceMappingURL=data:application/json;base64,FAKE", "/*# sourceMappingURL=spoof.map */"];
  for (const directive of directives) {
    const input = 'const value = "sourceMappingURL=literal";\n' + directive + "\n", stripped = browserSourceWithoutMapDirectives(input, "vendor.js", ts);
    assert.equal(stripped.length, input.length); assert.equal(stripped.split("\n").length, input.split("\n").length);
    assert.ok(stripped.includes('"sourceMappingURL=literal"')); assert.ok(!stripped.includes("spoof.map") && !stripped.includes("FAKE"));
  }
  const template = 'const text = `\n//# sourceMappingURL=literal.map\n`;';
  assert.equal(browserSourceWithoutMapDirectives(template, "vendor.js", ts), template);
  assert.equal(browserSourceWithoutMapDirectives(content, file, ts), content);
  const jsx = 'const view = <span>/*# sourceMappingURL=visible */</span>;';
  assert.equal(browserSourceWithoutMapDirectives(jsx, "view.tsx", ts), jsx);
});
