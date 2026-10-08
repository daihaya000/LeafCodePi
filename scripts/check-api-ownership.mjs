import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "web", "package.json"));
const ts = require("typescript");
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const OWNERS = new Set(["Next", "Backend", "Host"]);
const CONTRACTS = new Set(["json", "sse", "binary", "mixed", "empty"]);

/** Include exported functions, variables and named export aliases; ignore comments and helpers. */
export function exportedMethods(source) {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(file.parseDiagnostics.length, 0, "route source has syntax errors");
  const methods = new Set();
  for (const node of file.statements) {
    if (ts.isExportDeclaration(node) && !node.exportClause && !node.isTypeOnly) {
      throw new Error("wildcard route exports require explicit HTTP exports for ownership checking");
    }
    const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported && ts.isFunctionDeclaration(node) && node.name && HTTP_METHODS.has(node.name.text)) {
      methods.add(node.name.text);
    }
    if (exported && ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && HTTP_METHODS.has(declaration.name.text)) methods.add(declaration.name.text);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        if (!node.isTypeOnly && !element.isTypeOnly && HTTP_METHODS.has(element.name.text)) methods.add(element.name.text);
      }
    }
  }
  return [...methods].sort();
}

export function collectRoutes(root = ROOT) {
  const api = join(root, "web", "src", "app", "api");
  const routes = new Map();
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "route.ts") {
        const source = relative(root, path).replaceAll("\\", "/");
        const route = `/api/${relative(api, dirname(path)).replaceAll("\\", "/")}`;
        routes.set(route, { source, methods: exportedMethods(readFileSync(path, "utf8")) });
      }
    }
  }
  walk(api);
  return routes;
}

export function validateInventory(inventory, actual) {
  assert.equal(inventory.version, 1, "unsupported inventory version");
  assert.ok(Array.isArray(inventory.routes) && inventory.routes.length > 0, "empty inventory");
  const seen = new Set();
  let operations = 0;
  for (const record of inventory.routes) {
    assert.ok(!seen.has(record.route), `duplicate route: ${record.route}`);
    seen.add(record.route);
    const found = actual.get(record.route);
    assert.ok(found, `unknown route: ${record.route}`);
    assert.equal(record.source, found.source, `source mismatch: ${record.route}`);
    assert.ok(Object.hasOwn(inventory.groups, record.group), `unknown group: ${record.route}`);
    assert.ok(record.operations.length > 0, `no operations: ${record.route}`);
    assert.deepEqual(record.operations.map((op) => op.method).sort(), found.methods, `method mismatch: ${record.route}`);
    for (const operation of record.operations) {
      assert.ok(OWNERS.has(operation.owner), `invalid owner: ${record.route} ${operation.method}`);
      assert.ok(Number.isInteger(operation.phase) && operation.phase >= 0 && operation.phase <= 5, `invalid phase: ${record.route}`);
      assert.ok(CONTRACTS.has(operation.contract), `invalid contract: ${record.route}`);
      const decision = operation.owner === "Next" ? "retain-edge" : operation.owner === "Host" ? "thin-host-relay" : "thin-backend-relay";
      assert.equal(operation.decision, decision, `owner/decision mismatch: ${record.route}`);
      assert.ok(typeof operation.note === "string" && operation.note.length > 0, `missing rationale: ${record.route}`);
      operations += 1;
    }
  }
  assert.deepEqual([...seen].sort(), [...actual.keys()].sort(), "route coverage mismatch");
  return { routes: seen.size, operations };
}

export function ownershipTable(inventory) {
  return [
    "| 公開ルート | メソッド → 最終所有者 / 実施Phase | 分類 |",
    "|---|---|---|",
    ...inventory.routes.map((record) => `| \`${record.route}\` | ${record.operations.map((op) => `${op.method} → ${op.owner} / Phase${op.phase}`).join("<br>")} | ${record.group} |`),
  ].join("\n");
}

export function check(root = ROOT) {
  const inventory = JSON.parse(readFileSync(join(root, "docs", "plans", "next-thin-phase0.json"), "utf8"));
  const counts = validateInventory(inventory, collectRoutes(root));
  const document = readFileSync(join(root, "docs", "plans", "next-thin-phase0.md"), "utf8");
  assert.ok(document.includes(ownershipTable(inventory)), "Markdown ownership table differs from JSON");
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = check();
    console.log(`API ownership coverage: ${result.routes} routes / ${result.operations} operations; no missing, duplicate or unowned operations`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
