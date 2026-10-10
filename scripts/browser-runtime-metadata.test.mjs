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
