import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(resolve(ROOT, "web/package.json"));

// React 19.1.0: value tracking reads only checked/value; replay clones native Events.
// extend 3.0.2 reads only an own __proto__ descriptor under its fixed-name guard.
// These exact upstream bytes, not an arbitrary matching call shape, are trusted.
export const BROWSER_METADATA_SOURCES = Object.freeze({
  "react/cjs/react.production.js": "66fdfbcc9c1c7e1c35f8ccf462ea24ead8fba28172ac9d6cbc13a9d6d650094e",
  "react-dom/cjs/react-dom-client.production.js": "2f60615d2504361fadca40064af1b64b3657a85e32fdac09ce22b424dab522c5",
  "extend/index.js": "b4879ec38a11a2458846788b91be630e6b1d06eb07f9515adc1ff9030af0b00b",
});

/** Remove upstream source-map directives without changing code or positions.
 * The compiler must trace actual loaded bytes, not a vendor-supplied identity.
 */
export function browserSourceWithoutMapDirectives(code, file, ts = require("typescript")) {
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true), ranges = new Map(), literals = [];
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.RegularExpressionLiteral].includes(node.kind)) literals.push([node.getStart(ast), node.end]);
    for (const position of [node.pos, node.end]) for (const comment of [...ts.getLeadingCommentRanges(code, position) ?? [], ...ts.getTrailingCommentRanges(code, position) ?? []]) {
      if (/^[/*\s]*[#@]\s*sourceMappingURL\s*=/.test(code.slice(comment.pos, comment.end))) ranges.set(comment.pos, comment.end);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const [start, end] of [...ranges].sort(([a], [b]) => b - a)) {
    if (literals.some(([from, to]) => start < to && end > from)) continue;
    code = code.slice(0, start) + code.slice(start, end).replace(/[^\r\n]/g, " ") + code.slice(end);
  }
  return code;
}

/** Private compiler provenance allows only five audited metadata access sites. */
export function browserMetadataVerifier(chunk, ts = require("typescript")) {
  assert.ok(chunk.map, `${chunk.fileName}: Browser metadata source map required`);
  const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");
  const map = new TraceMap(chunk.map), sites = new Map();
  for (let i = 0; i < map.sources.length; i++) {
    const source = map.sources[i].replaceAll("\\", "/"), content = map.sourcesContent?.[i];
    const name = Object.keys(BROWSER_METADATA_SOURCES).find(name => source.endsWith("/node_modules/" + name));
    if (!name) continue;
    assert.equal(typeof content, "string", `${chunk.fileName}: metadata source bytes required`);
    assert.equal(createHash("sha256").update(content).digest("hex"), BROWSER_METADATA_SOURCES[name], `${chunk.fileName}: audited Browser metadata source changed: ${name}`);
    const ast = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true), allowed = [];
    function visit(node) {
      const text = node.getText(ast);
      if (ts.isPropertyAccessExpression(node) && ["pureComponentPrototype.constructor", "node.constructor", "nextBlockedOn.constructor"].includes(text)) allowed.push({ kind: "constructor", start: node.getStart(ast), end: node.end });
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "Object.getOwnPropertyDescriptor"
        && node.arguments[0]?.getText(ast) === "node.constructor.prototype" && node.arguments[1]?.getText(ast) === "valueField") allowed.push({ kind: "descriptor", start: node.getStart(ast), end: node.expression.end });
      if (name === "extend/index.js" && ts.isCallExpression(node) && text === "gOPD(obj, name)") allowed.push({ kind: "descriptor", start: node.getStart(ast), end: node.expression.end });
      ts.forEachChild(node, visit);
    }
    visit(ast); sites.set(map.resolvedSources[i], { ast, allowed });
  }
  return (kind, node) => {
    const generated = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    const original = originalPositionFor(map, { line: generated.line + 1, column: generated.character });
    const source = sites.get(original.source);
    if (!source || original.line === null || original.column === null) return false;
    const position = source.ast.getPositionOfLineAndCharacter(original.line - 1, original.column);
    return source.allowed.some(site => site.kind === kind && position >= site.start && position < site.end);
  };
}
