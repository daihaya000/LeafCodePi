import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRoutes, validateInventory } from "./check-api-ownership.mjs";
import { checkNextEntryBoundary } from "./check-next-entry-boundary.mjs";
import { checkNextTransportBoundary } from "./check-next-transport-boundary.mjs";
import { startupImports } from "./check-next-startup-boundary.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const REPORT = "docs/plans/vite-migration-phase0.json";
const normalize = value => value.replaceAll("\\", "/");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sorted = values => [...new Set(values)].sort();
const isCode = file => /\.[cm]?[jt]sx?$/.test(file);

export function sourceFacts(file, source, ts) {
  const ast = ts.createSourceFile(file, source.replaceAll("\r\n", "\n"), ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0, `${file}: syntax error`);
  const imports = [], frameworkUses = new Set(), environmentNames = new Set(), nextBindings = new Set();
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const clause = node.importClause, bindings = clause?.namedBindings;
      const allNamedTypes = bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0
        && bindings.elements.every(item => item.isTypeOnly) && !clause.name;
      const exportedBindings = node.exportClause;
      const allExportTypes = exportedBindings && ts.isNamedExports(exportedBindings) && exportedBindings.elements.length > 0
        && exportedBindings.elements.every(item => item.isTypeOnly);
      const typeOnly = !!(node.isTypeOnly || clause?.isTypeOnly || allNamedTypes || allExportTypes);
      const specifier = node.moduleSpecifier.text;
      imports.push({ specifier, kind: typeOnly ? "type" : "value", syntax: node.getText(ast) });
      if (specifier === "next" || specifier.startsWith("next/")) {
        if (clause?.name) nextBindings.add(clause.name.text);
        if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) nextBindings.add(item.name.text);
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      imports.push({ specifier: node.argument.literal.text, kind: "type", syntax: node.getText(ast) });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.ok(ts.isStringLiteral(node.arguments[0]), `${file}: nonliteral import`);
      imports.push({ specifier: node.arguments[0].text, kind: "dynamic", syntax: node.getText(ast) });
    }
    if (ts.isPropertyAccessExpression(node)) {
      const expression = node.getText(ast);
      if (["nextUrl", "cookies"].includes(node.name.text) || [...nextBindings].some(name => expression.startsWith(`${name}.`))) frameworkUses.add(expression);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(ast) === "process.env") environmentNames.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { imports, frameworkUses: sorted(frameworkUses), environmentNames: sorted(environmentNames),
    client: ast.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client") };
}

export function implicitMethods(methods) {
  const implicit = [];
  if (methods.includes("GET") && !methods.includes("HEAD")) implicit.push({ method: "HEAD", behavior: "GET handler; body suppressed by HTTP serving layer" });
  if (!methods.includes("OPTIONS")) implicit.push({ method: "OPTIONS", status: 204, allow: sorted(["OPTIONS", ...methods, ...(methods.includes("GET") ? ["HEAD"] : [])]).join(", ") });
  return implicit;
}

function walk(root, directory) {
  if (!existsSync(resolve(root, directory))) return [];
  const result = [];
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `${directory}/${entry.name}: inventory refuses symlinks`);
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...walk(root, file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}

function resolveImport(root, file, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("@shared/")) return null;
  const target = specifier.startsWith("@/") ? resolve(root, "web/src", specifier.slice(2))
    : specifier.startsWith("@shared/") ? resolve(root, "shared", specifier.slice(8)) : resolve(root, dirname(file), specifier);
  const found = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.mjs`, resolve(target, "index.ts")]
    .find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  assert.ok(found, `${file}: unresolved ${specifier}`);
  return normalize(relative(root, found));
}

/** Read-only by default. This is a snapshot of Next contracts, not a gateway acceptance test. */
export function migrationInventory(root = ROOT) {
  const ts = createRequire(resolve(ROOT, "web/package.json"))("typescript");
  const ownership = JSON.parse(readFileSync(resolve(root, "docs/plans/next-thin-phase0.json"), "utf8"));
  const actual = collectRoutes(root), counts = validateInventory(ownership, actual);
  const entry = checkNextEntryBoundary(root, ts);
  const runtime = checkNextTransportBoundary(root, ts, entry.entries, "entry", true).files;
  const graph = new Map(), facts = new Map();
  for (const file of runtime) {
    const source = readFileSync(resolve(root, file), "utf8");
    graph.set(file, isCode(file) ? startupImports(source, file, ts).map(specifier => resolveImport(root, file, specifier)).filter(Boolean) : []);
  }
  for (const file of entry.files) if (isCode(file)) facts.set(file, sourceFacts(file, readFileSync(resolve(root, file), "utf8"), ts));
  function closure(file) {
    const seen = new Set();
    function visit(target) { if (seen.has(target)) return; seen.add(target); for (const child of graph.get(target) ?? []) visit(child); }
    visit(file);
    return [...seen].sort();
  }
  const webFiles = walk(root, "web/src"), testFiles = webFiles.filter(file => /\.test\.[jt]sx?$/.test(file));
  const ownerCounts = {}, contractCounts = {}, relayCounts = {};
  const routes = ownership.routes.map(record => {
    const found = actual.get(record.route), modules = closure(found.source);
    const operations = record.operations.map(operation => {
      const owner = operation.owner === "Next" ? "Gateway" : operation.owner;
      ownerCounts[owner] = (ownerCounts[owner] ?? 0) + 1;
      contractCounts[operation.contract] = (contractCounts[operation.contract] ?? 0) + 1;
      return { method: operation.method, owner, gatewayAction: owner === "Gateway" ? "edge-only" : `relay-${owner.toLowerCase()}`,
        contract: operation.contract, note: operation.note };
    }).sort((a, b) => a.method.localeCompare(b.method, "en"));
    const relaySources = modules.filter(file => /^web\/src\/lib\//.test(file) && /(?:relay|transport|backend-runtime-events)/.test(file));
    for (const file of relaySources) relayCounts[file] = (relayCounts[file] ?? 0) + 1;
    return { route: record.route, source: found.source, group: record.group, operations, implicit: implicitMethods(found.methods),
      framework: facts.get(found.source), relaySources,
      contractSources: modules.filter(file => file.startsWith("shared/") && /(?:contract|protocol|http-client)/.test(file)),
      colocatedTests: testFiles.filter(file => dirname(file) === dirname(found.source)),
      comparisonRequired: ["auth", "method-status-dto", "query-headers", "owner-unavailable", "abort-deadline", "no-reexecution"] };
  }).sort((a, b) => a.route.localeCompare(b.route, "en"));
  const pages = webFiles.filter(file => /\/(?:page|layout|loading|error|not-found|template|default|global-error)\.[jt]sx?$/.test(file)).map(source => {
    const segments = source.replace(/^web\/src\/app\//, "").split("/").slice(0, -1).filter(segment => !/^\(.*\)$/.test(segment));
    return { source, url: "/" + segments.join("/"), facts: facts.get(source) ?? sourceFacts(source, readFileSync(resolve(root, source), "utf8"), ts) };
  });
  const frameworkImports = [...facts].filter(([, fact]) => fact.imports.some(item => item.specifier === "next" || item.specifier.startsWith("next/") || item.specifier === "next-themes"))
    .map(([source, fact]) => ({ source, ...fact, imports: fact.imports.filter(item => item.specifier === "next" || item.specifier.startsWith("next/") || item.specifier === "next-themes") }));
  const assets = sorted([...walk(root, "web/public"), ...webFiles.filter(file => /\.(?:css|ico|svg|png|jpg|jpeg|webp|woff2?|ttf)$/.test(file))]);
  const infrastructure = ["package.json", "web/package.json", "web/package-lock.json", "web/next.config.ts", "web/tsconfig.json", "web/tsconfig.build.json",
    "web/eslint.config.mjs", "web/postcss.config.mjs", "web/vitest.config.ts", "web/next-env.d.ts",
    "scripts/build-web.mjs", "scripts/web-build-mirror.mjs", "scripts/start-webui.bat", "scripts/launch-linux.sh", "start.bat",
    "host/src/index.js", "host/src/config.js", "host/src/web-plan.js", "host/src/stale-webui.js", "host/src/loopback-webui-proxy.js", "host/src/webui-auth.js",
    "backend/src/sdk-web-independence.test.mjs", "backend/src/sdk-web-independence-fixture.mjs", "docs/plans/next-thin-phase0.json",
    "scripts/check-next-entry-boundary.mjs", "scripts/check-next-ui-boundary.mjs", "scripts/check-next-transport-boundary.mjs", "scripts/check-next-startup-boundary.mjs"];
  // Generated next-env.d.ts is listed for migration, but not pinned: builds rewrite it.
  const pinned = sorted([...entry.files, ...assets, ...infrastructure.filter(file => file !== "web/next-env.d.ts" && existsSync(resolve(root, file)))]);
  const sources = pinned.map(source => {
    const bytes = readFileSync(resolve(root, source));
    const text = /\.(?:[cm]?[jt]sx?|json|css|svg|bat|sh)$/.test(source);
    return { source, sha256: sha256(text ? bytes.toString("utf8").replaceAll("\r\n", "\n") : bytes), hashMode: text ? "utf8-lf" : "bytes" };
  });
  return { version: 1, scope: "Next-to-Vite migration Phase0; observed source contracts, not runtime acceptance",
    counts: { ...counts, roots: entry.roots, runtimeModules: entry.modules, typeModules: entry.typeModules, ownerCounts, contractCounts,
      pages: pages.filter(page => /\/page\./.test(page.source)).length, assets: assets.length,
      implicitHeadRoutes: routes.filter(route => route.implicit.some(item => item.method === "HEAD")).length,
      implicitOptionsRoutes: routes.filter(route => route.implicit.some(item => item.method === "OPTIONS")).length },
    routes, pages, frameworkImports, relayCounts, assets, infrastructure, sources };
}

export function checkMigrationInventory(root = ROOT) {
  const recorded = JSON.parse(readFileSync(resolve(root, REPORT), "utf8"));
  const actual = migrationInventory(root);
  assert.deepEqual(recorded, actual, "Vite migration inventory is stale; inspect source changes before --write");
  return actual.counts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.slice(2).every(arg => arg === "--write"), "Usage: node scripts/inventory-vite-migration.mjs [--write]");
    const inventory = migrationInventory();
    if (process.argv.includes("--write")) {
      writeFileSync(resolve(ROOT, REPORT), JSON.stringify(inventory, null, 2) + "\n", "utf8");
      console.log("Wrote", REPORT, inventory.counts);
    } else {
      assert.deepEqual(JSON.parse(readFileSync(resolve(ROOT, REPORT), "utf8")), inventory, "Vite migration inventory is stale; inspect changes before --write");
      console.log("Vite migration inventory:", inventory.counts);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
