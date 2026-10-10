import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startupImports } from "./check-next-startup-boundary.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultParser = () => createRequire(resolve(ROOT, "web/package.json"))("typescript");
const EXTERNALS = new Set(["next/server", "undici", "node:crypto", "node:zlib"]);
// Keep the legacy checker independently importable until its replacement is complete.
const GATEWAY_HTTP_IMPORTS = ["undici/lib/dispatcher/agent.js", "undici/lib/dispatcher/client.js", "undici/lib/web/fetch/index.js"];
const normalize = (path) => path.replaceAll("\\", "/");
/** Migrated ingress only; full UI roots are checked separately. */
export const NEXT_TRANSPORT_ROOTS = Object.freeze([
  "web/src/proxy.ts",
  "web/src/app/api/auth/webui/route.ts",
  "web/src/lib/configuration-relay.ts",
  "web/src/lib/json-business-relay.ts",
  "web/src/lib/live-event-relay.ts",
  "web/src/lib/provider-auth-events-relay.ts",
  "web/src/lib/task-file-stream-relay.ts",
  "web/src/lib/backend-runtime-events.ts",
  "web/src/lib/host-folder-relay.ts",
  "web/src/app/api/build-info/route.ts",
  "web/src/app/api/health/route.ts",
  "web/src/app/api/llama-server/[action]/route.ts",
  "web/src/app/api/llama-server/ensure-loaded/route.ts",
  "web/src/app/api/llama-server/models/route.ts",
  "web/src/app/api/host/activity/route.ts",
  "web/src/app/api/host/browser-config/route.ts",
  "web/src/app/api/host/restart/route.ts",
  "web/src/app/api/host/webui-auth/route.ts",
  "web/src/app/api/pi/update/route.ts",
  "web/src/app/api/translation/status/route.ts",
  "web/src/app/api/translation/install/route.ts",
  "web/src/app/api/translation/override/route.ts",
]);
const within = (root, file) => {
  const rel = relative(root, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The generation pin is transport metadata, not permission to read/write business files. */
function generationReaderOnly(file, ts) {
  let reads = 0;
  const syntax = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "node:fs") {
      const clause = node.importClause, named = clause?.namedBindings;
      assert.ok(clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length === 1
        && named.elements[0].name.text === "readFileSync" && !named.elements[0].propertyName,
      "Backend transport may import only readFileSync for the generation marker");
      reads++;
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === "require")
      && node.arguments[0]?.text === "node:fs") {
      assert.fail("Dynamic filesystem loading is forbidden in transport");
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.equal(reads, 1, "Backend transport requires one named generation reader");
}

export function checkNextTransportBoundary(root = ROOT, ts = defaultParser(), roots = NEXT_TRANSPORT_ROOTS, kind = "transport", collectFiles = false) {
  root = realpathSync(root);
  const web = realpathSync(resolve(root, "web/src")), shared = realpathSync(resolve(root, "shared"));
  assert.equal(web, resolve(root, "web/src"), "Next source root cannot redirect to owner code");
  assert.equal(shared, resolve(root, "shared"), "Shared source root cannot redirect to owner code");
  const reader = resolve(shared, "backend-http-client.ts"), hostReader = resolve(shared, "host-http-client.ts");
  const visited = new Set();
  function visit(file) {
    const canonical = realpathSync(file);
    assert.ok(within(web, canonical) || within(shared, canonical), `Next transport cannot import owner code: ${normalize(file)}`);
    assert.ok(!/\.d\.[cm]?ts$/.test(canonical), `Declaration files are not executable dependencies: ${normalize(file)}`);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    if (kind !== "transport" && /\.(css|svg|png|jpg|webp)$/.test(canonical)) return;
    const source = readFileSync(canonical, "utf8");
    for (const specifier of startupImports(source, normalize(relative(root, canonical)), ts)) {
      if (EXTERNALS.has(specifier) || canonical === resolve(web, "lib/gateway-http.mjs") && GATEWAY_HTTP_IMPORTS.includes(specifier)) continue;
      if (kind !== "transport" && ["react", "react-dom", "lucide-react", "next-themes", "next/dynamic", "next/image", "next/link", "next/navigation", "next/headers", "next/og", "react-markdown", "remark-gfm"].includes(specifier)) continue;
      if (kind === "entry" && canonical === resolve(web, "lib/http-compression-fix.ts") && specifier === "node:http") continue;
      if (specifier === "node:os" && (canonical === resolve(shared, "webui-presentation.mjs") || kind !== "transport" && canonical === resolve(web, "app/layout.tsx"))) {
        const syntax = ts.createSourceFile(canonical, source, ts.ScriptTarget.Latest, true);
        const imports = syntax.statements.filter(n => ts.isImportDeclaration(n) && n.moduleSpecifier.text === "node:os");
        assert.equal(imports.length, 1, "UI hostname permits only a static named import");
        const clause = imports[0].importClause, bindings = clause?.namedBindings;
        assert.ok(!clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length === 1 && bindings.elements[0].name.text === "hostname" && !bindings.elements[0].propertyName, "UI may read only the host display name");
        continue;
      }
      if (canonical === hostReader && ["node:os", "node:path"].includes(specifier)) continue;
      if (specifier === "node:fs" && (canonical === reader || canonical === hostReader)) { generationReaderOnly(canonical, ts); continue; }
      assert.ok(specifier.startsWith("@/") || specifier.startsWith("@shared/") || specifier.startsWith("."),
        `${normalize(relative(root, canonical))}: forbidden transport import ${specifier}`);
      const target = specifier.startsWith("@/") ? resolve(web, specifier.slice(2))
        : specifier.startsWith("@shared/") ? resolve(shared, specifier.slice(8)) : resolve(dirname(canonical), specifier);
      // Resolve implementation files directly. TypeScript resolution of .mjs often returns .d.mts,
      // which would silently skip the actual shared runtime dependency graph.
      const found = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.mjs`, resolve(target, "index.ts")]
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      assert.ok(found, `${normalize(relative(root, canonical))}: unresolved transport import ${specifier}`);
      visit(found);
    }
  }
  for (const entry of roots) visit(resolve(root, entry));
  return { roots: roots.length, modules: visited.size, ...(collectFiles ? { files: [...visited].map(p => normalize(relative(root, p))).sort() } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log("Next migrated transport boundary:", checkNextTransportBoundary()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
