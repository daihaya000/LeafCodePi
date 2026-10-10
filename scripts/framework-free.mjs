import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const prohibited = value => /^(?:next(?:\/|$)|@next\/|eslint-config-next(?:\/|$))/.test(value);

/** Repository/config gate complements the production value/type/runtime closures. */
export function checkFrameworkFree(root = ROOT, ts = createRequire(join(ROOT, "web/package.json"))("typescript")) {
  for (const name of ["web/next.config.ts", "web/next.config.js", "web/next.config.mjs", "web/next-env.d.ts", "scripts/legacy-next-build.mjs", "scripts/web-build-mirror.mjs"]) assert.ok(!existsSync(join(root, name)), `Removed framework file restored: ${name}`);
  const web = join(root, "web");
  if (existsSync(web)) for (const name of readdirSync(web)) assert.ok(!/^next\.config\.|^next-env\.d\.ts$/.test(name), `Removed framework file restored: web/${name}`);
  let manifests = 0, sources = 0;
  const checkDependencies = (value, path) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!prohibited(key) && !(typeof item === "string" && /npm:(?:next(?:@|\/|$)|@next\/|eslint-config-next(?:@|$))/.test(item)), `${path}: framework manifest dependency ${key}`);
      checkDependencies(item, path);
    }
  };
  for (const folder of ["", "web", "gateway", "backend", "host"]) for (const name of ["package.json", "package-lock.json"]) {
    const path = join(root, folder, name); if (!existsSync(path)) continue; manifests++;
    const data = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]) checkDependencies(data[group], path);
    for (const [key, pkg] of Object.entries(data.packages ?? {})) {
      assert.ok(!/(?:^|\/)node_modules\/(?:next(?:\/|$)|@next\/|eslint-config-next(?:\/|$))/.test(key), `${path}: framework lock package ${key}`);
      for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) checkDependencies(pkg[group], path);
    }
    for (const command of Object.values(data.scripts ?? {})) assert.ok(!/(?:^|\s)next\s+(?:build|start|dev)\b|check-next-/.test(command), `${path}: legacy framework CLI`);
  }
  for (const path of ["web/tsconfig.json", "web/tsconfig.spa.json", "web/eslint.config.mjs"]) if (existsSync(join(root, path))) assert.doesNotMatch(readFileSync(join(root, path), "utf8"), /["']next["']|eslint-config-next|\.next\/|next-env\.d\.ts/, `${path}: framework config`);
  function walk(directory) {
    if (!existsSync(directory)) return;
    assert.ok(!lstatSync(directory).isSymbolicLink(), `Linked framework audit directory: ${directory}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["node_modules", "dist", "dist-spa", "runtime", "coverage"].includes(entry.name)) continue;
      const file = join(directory, entry.name); assert.ok(!entry.isSymbolicLink(), `Linked framework source: ${file}`);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) continue;
      const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true); sources++;
      const check = node => { if (node && ts.isStringLiteralLike(node)) assert.ok(!prohibited(node.text), `${file}: framework import/mock ${node.text}`); };
      function visit(node) {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal);
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node.moduleReference.expression);
        if (ts.isModuleDeclaration(node)) check(node.name);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require" || ts.isPropertyAccessExpression(node.expression) && ["mock", "doMock", "importActual", "importMock", "resolve"].includes(node.expression.name.text))) check(node.arguments[0]);
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  for (const folder of ["web/src", "gateway/src", "scripts", "host/src", "backend/src", "backend/runtime-src", "shared"]) walk(join(root, folder));
  return { manifests, sources };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkFrameworkFree())); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
