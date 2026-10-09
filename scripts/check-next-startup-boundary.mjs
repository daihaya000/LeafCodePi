import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultParser = () => createRequire(resolve(ROOT, "web/package.json"))("typescript");
const HTTP_MODULES = new Set(["node:http"]);
const normalize = (path) => path.replaceAll("\\", "/");

/** Value dependencies only; TypeScript-only declarations do not start services. */
export function startupImports(source, path = "instrumentation.ts", ts = defaultParser()) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, `${path}: syntax error`);
  const imports = [];
  function literal(node) {
    assert.ok(node && ts.isStringLiteralLike(node), `${path}: nonliteral module loading is forbidden`);
    imports.push(node.text);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) literal(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnly = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        literal(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

/** A narrow lifecycle gate, not the final Phase5 API/UI dependency gate. */
export function checkNextStartupBoundary(root = ROOT, ts = defaultParser()) {
  const sourceRoot = realpathSync(resolve(root, "web/src"));
  const oldStartup = resolve(sourceRoot, "lib/pi/runtime-startup.ts");
  assert.equal(existsSync(oldStartup), false, "Next local runtime startup must be removed");
  const visited = new Set();
  function visit(file) {
    const canonical = realpathSync(file);
    const rel = relative(sourceRoot, canonical);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), `Next startup cannot import owner code: ${normalize(file)}`);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const specifier of startupImports(readFileSync(canonical, "utf8"), normalize(rel), ts)) {
      if (HTTP_MODULES.has(specifier)) continue;
      assert.ok(specifier.startsWith("@/") || specifier.startsWith("."), `${normalize(rel)}: forbidden startup import ${specifier}`);
      const target = specifier.startsWith("@/") ? resolve(sourceRoot, specifier.slice(2)) : resolve(dirname(canonical), specifier);
      const found = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, resolve(target, "index.ts")]
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      assert.ok(found, `${normalize(rel)}: unresolved startup import ${specifier}`);
      visit(found);
    }
  }
  visit(resolve(sourceRoot, "instrumentation.ts"));
  return { modules: visited.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkNextStartupBoundary();
    console.log(`Next startup boundary: ${result.modules} modules; HTTP transport only, no Backend/SDK startup imports`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
