import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRoutes, validateInventory } from "./check-api-ownership.mjs";
import { checkGatewayRuntimePackage, GATEWAY_HTTP_IMPORTS } from "./gateway-runtime-boundary.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const norm = path => path.replaceAll("\\", "/");
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const forbidden = /^(?:next(?:\/|$)|@backend|@extensions|@earendil-works\/|@rahularya01\/pi-|pi-commandcode|better-sqlite3(?:\/|$))|^(?:backend(?:-core)?|host|extensions)\//;
const loaders = new Set(["require", "eval", "Function", "createRequire", "getBuiltinModule", "_load", "_compile", "compileFunction", "runInContext", "runInNewContext", "runInThisContext", "binding", "_linkedBinding", "dlopen", "loadEnvFile", "WebAssembly", "Worker", "SharedWorker", "importScripts"]);
const globals = new Set(["globalThis", "global", "window", "self"]);
const mutations = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "unlink", "unlinkSync", "rm", "rmSync", "rename", "renameSync", "mkdir", "mkdirSync", "truncate", "truncateSync", "chmod", "chown", "writev"]);
const browserPackages = new Set(["react", "react-dom", "lucide-react", "next-themes", "react-markdown", "remark-gfm"]);
const browserDefines = new Set(["process.env.NODE_ENV", "process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT", "process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE"]);
const parser = () => createRequire(resolve(ROOT, "web/package.json"))("typescript");
const fail = (file, message) => assert.fail(`${file}: ${message}`);

/** Includes erased imports, import(type), references and literal dynamic loaders. */
export function dependencyReferences(source, file = "boundary.ts", ts = parser(), { kind = "gateway", declaration = false, bundled = false } = {}) {
  const ast = ts.createSourceFile(resolve(file), source, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0, `${file}: syntax error`);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = name => norm(resolve(name)) === norm(ast.fileName) ? ast : undefined;
  const checker = ts.createProgram([ast.fileName], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  const isGlobal = node => ts.isIdentifier(node) && globals.has(node.text)
    && !checker.getSymbolAtLocation(node)?.declarations?.some(d => d.getSourceFile() === ast);
  const references = [];
  function add(node, typeOnly = false) {
    assert.ok(node && ts.isStringLiteralLike(node), `${file}: nonliteral module loading is forbidden`);
    references.push({ specifier: node.text, typeOnly });
  }
  function visit(node, inType = false) {
    inType ||= declaration || ts.isTypeNode(node);
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause, named = clause?.namedBindings;
      const erased = clause?.isTypeOnly || clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly);
      add(node.moduleSpecifier, Boolean(erased));
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause;
      add(node.moduleSpecifier, node.isTypeOnly || Boolean(named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly)));
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node.isTypeOnly);
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) add(node.name, true);
    if (ts.isImportTypeNode(node)) { assert.ok(ts.isLiteralTypeNode(node.argument), `${file}: nonliteral import type`); add(node.argument.literal, true); }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    if (!inType) {
      if (kind === "gateway" && ts.isIdentifier(node) && (mutations.has(node.text) || norm(file).endsWith("gateway/src/static.mjs") && node.text === "write")) fail(file, `store/filesystem mutation forbidden: ${node.text}`);
      if (ts.isBindingElement(node) && node.propertyName?.getText(ast) === "constructor") fail(file, "constructor code evaluation alias forbidden");
      if (ts.isIdentifier(node) && loaders.has(node.text)) fail(file, `indirect loader/code evaluation forbidden: ${node.text}`);
      if (ts.isPropertyAccessExpression(node) && (loaders.has(node.name.text) || !bundled && node.name.text === "constructor" || node.getText(ast).startsWith("import.meta.glob"))) fail(file, "indirect loader/code evaluation forbidden");
      if (ts.isElementAccessExpression(node) && (ts.isStringLiteralLike(node.argumentExpression) && (loaders.has(node.argumentExpression.text) || !bundled && node.argumentExpression.text === "constructor") || !bundled && isGlobal(node.expression))) fail(file, "computed loader/global access forbidden");
      if (!bundled && isGlobal(node)) {
        let receiver = node;
        while (ts.isAsExpression(receiver.parent) || ts.isParenthesizedExpression(receiver.parent) || ts.isNonNullExpression(receiver.parent)) receiver = receiver.parent;
        const direct = ts.isPropertyAccessExpression(receiver.parent) && receiver.parent.expression === receiver;
        const typeOf = ts.isTypeOfExpression(receiver.parent);
        const named = node.parent.name === node && !ts.isShorthandPropertyAssignment(node.parent);
        assert.ok(direct || typeOf || named, `${file}: global loader alias/destructuring forbidden`);
      }
      if (!bundled && kind === "browser" && ts.isIdentifier(node) && node.text === "process") {
        let parent = node; while (ts.isPropertyAccessExpression(parent.parent) && parent.parent.expression === parent) parent = parent.parent;
        assert.ok(browserDefines.has(parent.getText(ast)), `${file}: Node process capability forbidden`);
      }
    }
    if (kind === "browser" && ts.isIdentifier(node) && node.text === "NodeJS") fail(file, "Node type dependency forbidden");
    ts.forEachChild(node, child => visit(child, inType));
  }
  visit(ast);
  for (const item of ast.typeReferenceDirectives) references.push({ specifier: item.fileName === "node" ? "node:types" : item.fileName, typeOnly: true, typeReference: true });
  for (const item of ast.referencedFiles) references.push({ specifier: item.fileName, typeOnly: true, pathReference: true });
  return references;
}

export function checkSpecifier(specifier, kind, file) {
  assert.ok(!forbidden.test(norm(specifier)), `${file}: forbidden value/type dependency ${specifier}`);
  if (kind === "browser") assert.ok(!specifier.startsWith("node:") && !builtins.has(specifier), `${file}: Node dependency forbidden: ${specifier}`);
}

export function checkProductionFile(file, root, kind, { packageFile = false, tsLib = false } = {}) {
  const canonical = realpathSync(file);
  let name = norm(relative(root, file));
  const key = path => process.platform === "win32" ? norm(path).toLowerCase() : norm(path);
  if (packageFile && !tsLib) {
    // Compiler dependencies may be borrowed by isolated fixtures, but only from this
    // checker's own installed Web packages, never a caller-selected owner directory.
    const approved = [resolve(root, "web/node_modules"), resolve(ROOT, "web/node_modules")].find(base => {
      const rel = relative(base, canonical); return rel && !rel.startsWith("..") && !isAbsolute(rel);
    });
    assert.ok(approved, `${name}: package symlink escape`);
    name = "web/node_modules/" + norm(relative(approved, canonical));
  } else assert.equal(key(canonical), key(resolve(file)), `${name}: symlink escape`);
  if (tsLib) return;
  assert.ok(!isAbsolute(name) && !name.startsWith("../"), `${name}: production closure escaped checkout`);
  assert.ok(!forbidden.test(name) && !/(?:^|\/)(?:node_modules\/next\/|node_modules\/@earendil-works\/)|\.test\./.test(name), `${name}: forbidden production source`);
  if (packageFile) {
    assert.ok(name.startsWith("web/node_modules/"), `${name}: unexpected package root`);
    const packageName = name.match(/^web\/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
    checkSpecifier(packageName ?? "", kind, name);
    if (kind === "gateway") assert.ok(["@types/node", "undici-types", "undici"].includes(packageName), `${name}: unexpected gateway type package`);
    if (kind === "browser") assert.ok(!/\/node_modules\/(?:@types\/node|undici(?:-types)?)(?:\/|$)/.test("/" + name), `${name}: Node type dependency forbidden`);
    return;
  }
  const allowed = kind === "browser" ? ["web/src/", "shared/"] : ["gateway/src/", "web/src/app/api/", "web/src/lib/", "shared/"];
  assert.ok(allowed.some(prefix => name.startsWith(prefix)) || kind === "browser" && name === "web/index.html", `${name}: forbidden owner source`);
  if (kind === "gateway" && ["shared/", "web/src/lib/"].some(prefix => name.startsWith(prefix))) {
    const policyFile = resolve(ROOT, "scripts/gateway-contracts.json"), policy = JSON.parse(readFileSync(policyFile, "utf8"));
    assert.equal(policy.version, 1, "Unsupported gateway contract policy");
    assert.ok(policy.files.includes(name), `${name}: unaudited owner/store/contract dependency`);
  }
  if (kind === "browser") assert.ok(!name.startsWith("web/src/app/api/") && !name.startsWith("web/src/platform/"), `${name}: forbidden Browser transport/framework source`);
  assert.ok(!name.startsWith("web/src/lib/pi/") || kind === "browser" && name === "web/src/lib/pi/messages.ts", `${name}: forbidden compatibility owner source`);
}

function compilerOptions(root, kind, ts) {
  if (kind === "browser") {
    const path = resolve(root, "web/tsconfig.spa.json"), config = ts.readConfigFile(path, ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "web"), undefined, path);
    assert.equal(parsed.errors.length, 0); return parsed;
  }
  return { options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    noEmit: true, skipLibCheck: true, allowJs: true, esModuleInterop: true, resolveJsonModule: true, baseUrl: resolve(root, "web"),
    paths: { "@/*": ["src/*"], "@shared/*": ["../shared/*"] }, types: ["node"], typeRoots: [resolve(root, "web/node_modules/@types")] } };
}

function gatewayCapability(file, specifier, ts, source) {
  const cap = file === "web/src/lib/gateway-http.mjs" ? GATEWAY_HTTP_IMPORTS
    : file === "gateway/src/static.mjs" ? ["node:fs", "node:fs/promises", "node:crypto", "node:path"]
    : file.startsWith("gateway/") ? ["node:http", "node:stream", "node:events"]
    : file === "shared/host-http-client.ts" ? ["node:fs", "node:os", "node:path"]
    : file === "shared/backend-http-client.ts" ? ["node:fs"]
    : file === "shared/webui-presentation.mjs" ? ["node:os"]
    : file === "web/src/lib/http-compression-fix.ts" ? ["node:http"] : ["node:crypto", "node:zlib"];
  assert.ok(cap.includes(specifier), `${file}: forbidden gateway OS/store capability ${specifier}`);
  if (file === "gateway/src/static.mjs" && ["node:fs", "node:fs/promises"].includes(specifier)) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(n => ts.isImportDeclaration(n) && n.moduleSpecifier.text === specifier);
    const allowed = specifier === "node:fs" ? ["constants"] : ["lstat", "open", "readdir", "realpath"];
    assert.equal(imports.length, 1, "Static snapshot requires one named read-only filesystem import");
    const clause = imports[0].importClause, bindings = clause?.namedBindings;
    assert.ok(!clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every(e => allowed.includes(e.name.text) && !e.propertyName), "Static snapshot may acquire only audited read-only filesystem capabilities");
    if (specifier === "node:fs/promises") {
      function audit(node) {
        if (ts.isIdentifier(node) && node.text === "open") {
          const direct = ts.isCallExpression(node.parent) && node.parent.expression === node;
          const imported = ts.isImportSpecifier(node.parent) && node.parent.name === node;
          assert.ok(direct || imported, "Static snapshot open aliases are forbidden");
          if (direct) assert.equal(node.parent.arguments[1]?.getText(ast).replace(/\s+/g, ""), "constants.O_RDONLY|(constants.O_NOFOLLOW??0)", "Static snapshot open must use audited read-only flags");
        }
        ts.forEachChild(node, audit);
      }
      audit(ast);
    }
  }
  if (specifier === "node:fs" && ["shared/host-http-client.ts", "shared/backend-http-client.ts"].includes(file)) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(n => ts.isImportDeclaration(n) && n.moduleSpecifier.text === specifier);
    assert.equal(imports.length, 1, `${file}: only one generation/discovery reader allowed`);
    const clause = imports[0].importClause, bindings = clause?.namedBindings;
    assert.ok(!clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length === 1 && bindings.elements[0].name.text === "readFileSync" && !bindings.elements[0].propertyName, `${file}: only readFileSync metadata capability allowed`);
  }
}

/** First-party executable graph + complete compiler-resolved type graph (including packages). */
export function checkProductionBoundary(root = ROOT, kind = "browser", { ts = parser(), entries, virtual = new Map(), diagnostics = true, reportFiles = false } = {}) {
  root = realpathSync(root);
  const config = compilerOptions(root, kind, ts), options = config.options;
  entries ??= kind === "browser" ? config.fileNames : [resolve(root, "gateway/src/index.mjs")];
  const sources = new Map(), runtimeImports = new Set();
  function implementation(file, specifier) {
    const parsed = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
    const raw = specifier.startsWith(".") ? resolve(dirname(file), specifier)
      : specifier.startsWith("@shared/") ? resolve(root, "shared", specifier.slice(8))
      : specifier.startsWith("@/") ? resolve(root, "web/src", specifier.slice(2)) : null;
    if (parsed && /\.d\.[cm]ts$/.test(parsed.resolvedFileName)) {
      const runtime = parsed.resolvedFileName.replace(/\.d\.(m|c)ts$/, ".$1js");
      if (existsSync(runtime) && statSync(runtime).isFile()) return runtime;
    }
    if (raw && /\.[cm]?js$/.test(specifier) && existsSync(raw) && statSync(raw).isFile()) return raw;
    if (raw && virtual.has(raw)) return raw;
    if (parsed && !/\.d\.[cm]?ts$/.test(parsed.resolvedFileName)) return parsed.resolvedFileName;
    if (raw && /\.(?:css|svg|png|webp|jpg)$/.test(raw) && existsSync(raw)) return raw;
    assert.fail(`${file}: unresolved runtime dependency ${specifier}`);
  }
  function visit(file) {
    file = resolve(file); if (sources.has(file)) return;
    if (!virtual.has(file)) checkProductionFile(file, root, kind);
    const source = virtual.get(file) ?? readFileSync(file, "utf8"); sources.set(file, source);
    if (/\.(?:css|svg|png|webp|jpg)$/.test(file)) return;
    for (const edge of dependencyReferences(source, norm(relative(root, file)), ts, { kind, declaration: /\.d\.[cm]?ts$/.test(file) })) {
      checkSpecifier(edge.specifier, kind, file);
      if (kind === "gateway" && (edge.specifier.startsWith("node:") || builtins.has(edge.specifier))) gatewayCapability(norm(relative(root, file)), edge.specifier, ts, source);
      const external = !edge.specifier.startsWith(".") && !edge.specifier.startsWith("@/") && !edge.specifier.startsWith("@shared/") && !isAbsolute(edge.specifier);
      if (external && !edge.typeOnly) {
        if (kind === "browser") assert.ok(browserPackages.has(edge.specifier.split("/").slice(0, edge.specifier.startsWith("@") ? 2 : 1).join("/")), `${file}: unexpected Browser runtime package ${edge.specifier}`);
        else { gatewayCapability(norm(relative(root, file)), edge.specifier, ts, source); if (!edge.specifier.startsWith("node:") && !builtins.has(edge.specifier)) runtimeImports.add(edge.specifier); }
        continue;
      }
      if (!edge.typeOnly) visit(implementation(file, edge.specifier));
    }
  }
  entries.forEach(visit);
  const host = ts.createCompilerHost(options), originalRead = host.readFile, originalExists = host.fileExists;
  host.readFile = file => virtual.get(resolve(file)) ?? originalRead(file);
  host.fileExists = file => virtual.has(resolve(file)) || originalExists(file);
  const program = ts.createProgram([...sources.keys()].filter(file => !/\.(?:css|svg|png|webp|jpg)$/.test(file)), options, host);
  const libRoot = dirname(ts.getDefaultLibFilePath(options));
  for (const file of program.getSourceFiles()) {
    const tsLib = dirname(file.fileName) === libRoot, packageFile = norm(file.fileName).includes("/node_modules/");
    if (!virtual.has(resolve(file.fileName))) checkProductionFile(file.fileName, root, kind, { packageFile, tsLib });
    if (tsLib) continue;
    if (packageFile && kind === "gateway") {
      // skipLibCheck must not erase forbidden or unresolved imports in vendor declarations.
      const base = norm(file.fileName).match(/^(.*\/node_modules\/(?:(?:@[^/]+\/)?[^/]+))\//)?.[1];
      for (const edge of dependencyReferences(file.text, file.fileName, ts, { kind, declaration: true })) {
        checkSpecifier(edge.specifier, kind, file.fileName);
        if (edge.pathReference || edge.specifier.startsWith(".") || isAbsolute(edge.specifier)) {
          const name = relative(base, resolve(dirname(file.fileName), edge.specifier));
          assert.ok(name && !name.startsWith("..") && !isAbsolute(name), `${file.fileName}: gateway package type escape`);
        } else assert.ok(edge.specifier.startsWith("node:") || builtins.has(edge.specifier) || /^(?:undici(?:-types)?(?:\/|$)|@types\/node(?:\/|$))/.test(edge.specifier), `${file.fileName}: unaudited gateway type dependency ${edge.specifier}`);
      }
      continue;
    }
    for (const edge of dependencyReferences(file.text, file.fileName, ts, { kind, declaration: file.isDeclarationFile })) {
      checkSpecifier(edge.specifier, kind, file.fileName);
      if (kind === "gateway" && (edge.specifier.startsWith("node:") || builtins.has(edge.specifier))) gatewayCapability(norm(relative(root, file.fileName)), edge.specifier, ts, file.text);
    }
  }
  if (diagnostics) {
    const errors = ts.getPreEmitDiagnostics(program);
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => "\n" }));
  }
  const runtimePackages = kind === "gateway" && runtimeImports.size ? checkGatewayRuntimePackage(root, { imports: [...runtimeImports], ts, reportFiles }) : {};
  return { runtimeSources: sources.size, typeSources: program.getSourceFiles().length, ...runtimePackages,
    ...(reportFiles ? { runtimeFiles: [...sources.keys()].map(file => norm(relative(root, file))).sort(), typeFiles: program.getSourceFiles().map(file => norm(relative(root, file.fileName))).filter(file => !file.includes("node_modules/")).sort() } : {}) };
}

export function checkBrowserBoundary(root = ROOT, options = {}) { return checkProductionBoundary(root, "browser", options); }
export function checkGatewayBoundary(root = ROOT, options = {}) {
  const routes = collectRoutes(root), counts = validateInventory(JSON.parse(readFileSync(resolve(root, "docs/plans/next-thin-phase0.json"), "utf8")), routes);
  const source = "export const routes = [\n" + [...routes].map(([route, record]) => ` { route: ${JSON.stringify(route)}, methods: ${JSON.stringify(record.methods)}, load: () => import(${JSON.stringify("../../" + record.source)}) },`).join("\n") + "\n];\n";
  return { ...counts, ...checkProductionBoundary(root, "gateway", { ...options, virtual: new Map([[resolve(root, "gateway/src/routes.mjs"), source]]) }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || args.length === 1 && ["--browser", "--gateway"].includes(args[0]), "Unsupported production boundary option");
    console.log(JSON.stringify({ ...(args[0] !== "--gateway" ? { browser: checkBrowserBoundary() } : {}), ...(args[0] !== "--browser" ? { gateway: checkGatewayBoundary() } : {}) }));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
