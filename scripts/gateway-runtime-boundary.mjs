import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const norm = path => path.replaceAll("\\", "/");
const key = path => process.platform === "win32" ? norm(path).toLowerCase() : norm(path);
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const loaders = new Set(["eval", "Function", "createRequire", "getBuiltinModule", "_load", "_compile", "compileFunction", "runInContext", "runInNewContext", "runInThisContext", "binding", "_linkedBinding", "dlopen", "loadEnvFile", "Worker", "SharedWorker", "importScripts"]);
const mutation = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "unlink", "unlinkSync", "rename", "renameSync", "mkdir", "mkdirSync", "truncate", "truncateSync", "DatabaseSync"]);
const entryFiles = ["lib/dispatcher/agent.js", "lib/dispatcher/client.js", "lib/web/fetch/index.js"];
export const GATEWAY_HTTP_IMPORTS = Object.freeze(entryFiles.map(file => "undici/" + file));
const parser = () => createRequire(resolve(ROOT, "web/package.json"))("typescript");

/** CJS loader syntax is permitted only as a direct one-argument literal call. */
export function runtimeReferences(source, file, ts = parser()) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, `${file}: external runtime syntax error`);
  const references = [];
  function add(node) {
    assert.ok(node && ts.isStringLiteralLike(node), `${file}: nonliteral external loader forbidden`);
    references.push(node.text);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node)) {
      assert.ok(ts.isLiteralTypeNode(node.argument), `${file}: nonliteral external import type`); add(node.argument.literal);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.equal(node.arguments.length, 1, `${file}: unsupported dynamic import options`); add(node.arguments[0]);
    }
    if (ts.isIdentifier(node) && node.text === "require") {
      assert.ok(ts.isCallExpression(node.parent) && node.parent.expression === node && node.parent.arguments.length === 1, `${file}: indirect external require forbidden`);
      add(node.parent.arguments[0]);
    }
    if (ts.isIdentifier(node) && loaders.has(node.text)) {
      // Brand-checking intrinsic, not code generation; the entire file is hash-pinned below.
      const intrinsic = file === "lib/web/webidl/index.js" && node.text === "Function" && ["Function.call", "Function.prototype"].includes(node.parent.getText(ast));
      assert.ok(intrinsic, `${file}: external loader/code evaluation forbidden: ${node.text}`);
    }
    if (ts.isIdentifier(node) && mutation.has(node.text)) assert.fail(`${file}: external store mutation forbidden: ${node.text}`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && (loaders.has(node.argumentExpression.text) || node.argumentExpression.text === "require")) assert.fail(`${file}: computed external loader forbidden`);
    if (ts.isElementAccessExpression(node) && ["globalThis", "global", "process"].includes(node.expression.getText(ast))) {
      const intrinsic = file === "lib/global.js" && node.getText(ast) === "globalThis[globalDispatcher]"
        || file === "lib/web/fetch/global.js" && node.getText(ast) === "globalThis[globalOrigin]";
      assert.ok(intrinsic, `${file}: external computed global loader forbidden`);
    }
    if (ts.isIdentifier(node) && node.text === "WebAssembly") {
      // Only llhttp's two fixed, package-local WASM binaries and parser callback table.
      assert.ok(file === "lib/dispatcher/client-h1.js" && ["WebAssembly.Module", "WebAssembly.Instance"].includes(node.parent.getText(ast)), `${file}: external WASM loader forbidden`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const item of [...ast.typeReferenceDirectives, ...ast.referencedFiles]) references.push(item.fileName);
  return [...new Set(references)].sort();
}

/** Exact locked HTTP implementation, never the broad undici root/cache/mock entry. */
export function checkGatewayRuntimePackage(root = ROOT, { packageRoot = resolve(root, "web/node_modules/undici"), imports = GATEWAY_HTTP_IMPORTS, ts = parser(), reportFiles = false } = {}) {
  const policy = JSON.parse(readFileSync(resolve(ROOT, "scripts/gateway-runtime-contracts.json"), "utf8"));
  assert.equal(policy.version, 1, "Unsupported gateway runtime policy");
  assert.deepEqual(policy.entries, entryFiles, "Unexpected gateway runtime entries");
  assert.ok(imports.every(name => GATEWAY_HTTP_IMPORTS.includes(name)), "Unaudited gateway external entry");
  const logicalRoot = resolve(packageRoot), canonicalRoot = realpathSync(logicalRoot);
  // Isolated source fixtures may borrow only this checker's already-audited install.
  assert.ok(key(canonicalRoot) === key(logicalRoot) || key(canonicalRoot) === key(resolve(ROOT, "web/node_modules/undici")), "Gateway runtime package symlink escape");
  function regular(file) {
    const target = resolve(logicalRoot, file), actual = realpathSync(target);
    assert.equal(key(actual), key(resolve(canonicalRoot, file)), `${file}: external runtime symlink escape`);
    assert.ok(statSync(target).isFile(), `${file}: external runtime must be a regular file`);
    return target;
  }
  const manifestBytes = readFileSync(regular("package.json")), pkg = JSON.parse(manifestBytes);
  assert.equal(pkg.name, "undici"); assert.equal(pkg.version, policy.packageVersion, "Unaudited gateway runtime version");
  assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), policy.packageSha256, "Gateway runtime manifest changed");
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, "Undici must not add external runtime dependencies");
  const visited = new Set(), native = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    assert.ok(policy.files[file], `${file}: unaudited gateway runtime source/store`);
    const target = regular(file), bytes = readFileSync(target), source = bytes.toString("utf8");
    const references = runtimeReferences(source, file, ts);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), policy.files[file].sha256, `${file}: gateway runtime source changed; re-audit required`);
    assert.deepEqual(references, policy.files[file].references, `${file}: gateway runtime dependency graph changed`);
    visited.add(file);
    for (const specifier of references) {
      if (builtins.has(specifier.replace(/^node:/, ""))) {
        assert.ok(policy.files[file].builtins.includes(specifier), `${file}: unaudited external OS capability ${specifier}`);
        native.add(specifier); continue;
      }
      assert.ok(specifier.startsWith("."), `${file}: external package/owner dependency forbidden ${specifier}`);
      const stem = resolve(dirname(target), specifier);
      const found = [stem, stem + ".js", stem + ".json", resolve(stem, "index.js")].find(path => existsSync(path) && statSync(path).isFile());
      assert.ok(found, `${file}: unresolved external runtime dependency ${specifier}`);
      const name = norm(relative(logicalRoot, found));
      assert.ok(!name.startsWith("../") && !isAbsolute(name), `${file}: external runtime escaped package`);
      visit(name);
    }
  }
  for (const name of imports) visit(name.slice("undici/".length));
  return { runtimePackage: `undici@${pkg.version}`, runtimePackageSources: visited.size,
    runtimePackageBuiltins: [...native].sort(), ...(reportFiles ? { runtimePackageFiles: [...visited].sort() } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkGatewayRuntimePackage(ROOT, { ...(process.argv[2] ? { packageRoot: resolve(process.argv[2]) } : {}) }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
