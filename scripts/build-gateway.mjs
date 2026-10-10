import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRoutes, validateInventory } from "./check-api-ownership.mjs";
import { dependencyReferences, checkGatewayBoundary } from "./production-boundary.mjs";
import { GATEWAY_HTTP_IMPORTS } from "./gateway-runtime-boundary.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const norm = value => value.replaceAll("\\", "/");
const emitted = file => file.replace(/\.tsx?$/, ".mjs");
const externals = new Set([...GATEWAY_HTTP_IMPORTS, "node:http", "node:stream", "node:events", "node:crypto", "node:zlib", "node:fs", "node:fs/promises", "node:os", "node:path"]);

export function gatewayGraph(root = ROOT, ts = createRequire(resolve(ROOT, "web/package.json"))("typescript")) {
  const actual = collectRoutes(root);
  const counts = validateInventory(JSON.parse(readFileSync(resolve(root, "docs/plans/next-thin-phase0.json"), "utf8")), actual);
  // The established gate covers values, erased types, OS capabilities and external CJS.
  const boundary = checkGatewayBoundary(root, { ts });
  const manifest = [...actual].sort(([a], [b]) => a.localeCompare(b, "en")).map(([route, record]) => ({ route, ...record }));
  const routeSource = "export const routes = [\n" + manifest.map(record => {
    const specifier = "../../" + record.source;
    return `  { route: ${JSON.stringify(record.route)}, methods: ${JSON.stringify(record.methods)}, load: () => import(${JSON.stringify(specifier)}) },`;
  }).join("\n") + "\n];\n";
  const sources = new Map(), declarations = new Map(), virtual = new Map([["gateway/src/routes.mjs", routeSource]]);
  const roots = ["gateway/src/index.mjs"];
  function allowed(file) {
    assert.ok(["gateway/src/", "web/src/app/api/", "web/src/lib/", "shared/"].some(prefix => file.startsWith(prefix)), `Gateway cannot import owner/UI source: ${file}`);
    assert.doesNotMatch(file, /^web\/src\/lib\/pi\/|\.test\./, `Gateway cannot import compatibility owner/test source: ${file}`);
  }
  function target(file, specifier) {
    if (externals.has(specifier)) {
      if (file.startsWith("gateway/")) {
        // The static snapshot reader alone may read/hash a configured build directory.
        // Keep the entry/router/API relays unable to acquire filesystem/process capabilities.
        const capabilities = file === "gateway/src/static.mjs" ? ["node:fs/promises", "node:fs", "node:crypto", "node:path"] : ["node:http", "node:stream", "node:events"];
        assert.ok(capabilities.includes(specifier), `Unexpected gateway OS capability: ${specifier}`);
      }
      return null;
    }
    assert.ok(specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("@shared/"), `${file}: forbidden dependency ${specifier}`);
    const stem = specifier.startsWith("@/") ? resolve(root, "web/src", specifier.slice(2)) : specifier.startsWith("@shared/") ? resolve(root, "shared", specifier.slice(8)) : resolve(root, dirname(file), specifier);
    const found = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}.mjs`, resolve(stem, "index.ts")].find(candidate => virtual.has(norm(relative(root, candidate))) || existsSync(candidate) && statSync(candidate).isFile());
    assert.ok(found, `${file}: unresolved ${specifier}`);
    const name = norm(relative(root, found)); allowed(name);
    if (!virtual.has(name)) assert.equal(realpathSync(found), found, `${name}: symlink escape`);
    return name;
  }
  function visit(file) {
    if (sources.has(file)) return;
    allowed(file);
    const source = virtual.get(file) ?? readFileSync(resolve(root, file), "utf8");
    sources.set(file, source);
    const sidecar = file.replace(/\.mjs$/, ".d.mts");
    if (sidecar !== file && existsSync(resolve(root, sidecar))) {
      assert.equal(realpathSync(resolve(root, sidecar)), resolve(root, sidecar), `${sidecar}: declaration symlink escape`);
      declarations.set(sidecar, readFileSync(resolve(root, sidecar), "utf8"));
    }
    // Reject Next even in type-only imports, before the compiler could erase the evidence.
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function inspect(node) {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier.text;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal.text;
      if (specifier) assert.doesNotMatch(specifier, /^(?:next(?:\/|$)|@backend|@extensions|@earendil|pi-commandcode|better-sqlite3)/, `${file}: forbidden value/type dependency`);
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
    for (const specifier of dependencyReferences(source, file, ts).filter(edge => !edge.typeOnly).map(edge => edge.specifier)) { const dependency = target(file, specifier); if (dependency) visit(dependency); }
  }
  roots.forEach(visit);
  return { sources, declarations, target, manifest, counts, ts, boundary };
}

export function buildGateway(root = ROOT, { typecheck = true } = {}) {
  // Retain the option for callers, but a false value cannot bypass the boundary/type gate.
  const graph = gatewayGraph(root), { ts } = graph;
  const output = resolve(root, "gateway/dist"), stage = resolve(root, `gateway/.build-${process.pid}`), backup = resolve(root, `gateway/.previous-${process.pid}`);
  assert.equal(existsSync(stage), false, "Gateway staging directory already exists");
  mkdirSync(stage, { recursive: true });
  try {
    for (const [file, source] of graph.sources) {
      const compiled = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, allowJs: true } }).outputText;
      const transformer = context => node => {
        function visit(current) {
          if (ts.isStringLiteral(current) && (ts.isImportDeclaration(current.parent) || ts.isExportDeclaration(current.parent)
            || ts.isCallExpression(current.parent) && current.parent.expression.kind === ts.SyntaxKind.ImportKeyword)) {
            const dependency = graph.target(file, current.text);
            if (dependency) {
              let specifier = norm(relative(dirname(emitted(file)), emitted(dependency)));
              if (!specifier.startsWith(".")) specifier = "./" + specifier;
              return ts.factory.createStringLiteral(specifier);
            }
          }
          return ts.visitEachChild(current, visit, context);
        }
        return ts.visitNode(node, visit);
      };
      const ast = ts.createSourceFile(emitted(file), compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const transformed = ts.transform(ast, [transformer]);
      const text = ts.createPrinter().printFile(transformed.transformed[0]); transformed.dispose();
      for (const specifier of dependencyReferences(text, emitted(file), ts).filter(edge => !edge.typeOnly).map(edge => edge.specifier)) assert.ok(externals.has(specifier) || specifier.startsWith("."), `Unsafe emitted import: ${specifier}`);
      const dest = resolve(stage, emitted(file)); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, text, "utf8");
    }
    writeFileSync(resolve(stage, "manifest.json"), JSON.stringify({ ...graph.counts, runtimeModules: graph.sources.size, sources: [...graph.sources.keys()].sort(), routes: graph.manifest }, null, 2) + "\n");
    if (existsSync(output)) renameSync(output, backup);
    try { renameSync(stage, output); } catch (error) { if (existsSync(backup)) renameSync(backup, output); throw error; }
    if (existsSync(backup)) rmSync(backup, { recursive: true });
  } finally { if (existsSync(stage)) rmSync(stage, { recursive: true }); }
  return { ...graph.counts, runtimeModules: graph.sources.size, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log("Gateway build:", buildGateway()); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
