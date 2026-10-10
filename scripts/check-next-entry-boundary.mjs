import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nextUiRoots } from "./check-next-ui-boundary.mjs";
import { checkNextStartupBoundary } from "./check-next-startup-boundary.mjs";
import { checkNextTransportBoundary } from "./check-next-transport-boundary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const normalize = p => p.replaceAll("\\", "/");
const within = (root, p) => { const rel = relative(root, p); return rel && !rel.startsWith("..") && !isAbsolute(rel); };
/** All framework entry conventions, not a hand-maintained migrated-route list. */
export function nextEntryRoots(root = ROOT) {
  const web = resolve(root, "web/src"), roots = new Set(nextUiRoots(root));
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      assert.equal(realpathSync(p), p, "Next entries cannot be redirected by symlinks");
      if (e.isDirectory()) { walk(p); continue; }
      const rel = normalize(relative(web, p));
      if (/^app\/(?:.*\/)?(?:route|robots|sitemap|manifest|icon|apple-icon|opengraph-image|twitter-image)\.[jt]sx?$/.test(rel)) roots.add("web/src/" + rel);
    }
  }
  walk(resolve(web, "app"));
  for (const name of ["instrumentation", "instrumentation-client", "proxy", "middleware"]) {
    for (const ext of ["ts", "tsx", "js", "jsx"]) if (existsSync(resolve(web, `${name}.${ext}`))) roots.add(`web/src/${name}.${ext}`);
  }
  return [...roots].sort();
}
/** Check type-only edges too: a production typecheck must not need Backend/SDK source. */
function typeClosure(root, files, ts) {
  const web = realpathSync(resolve(root, "web/src")), shared = realpathSync(resolve(root, "shared")), visited = new Set();
  function visit(file) {
    const canonical = realpathSync(file);
    assert.ok(within(web, canonical) || within(shared, canonical), `Next types cannot import owner code: ${file}`);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    if (!/\.[cm]?[jt]sx?$/.test(canonical)) return;
    if (canonical.endsWith(".mjs") && existsSync(canonical.slice(0, -4) + ".d.mts")) visit(canonical.slice(0, -4) + ".d.mts");
    const source = ts.createSourceFile(canonical, readFileSync(canonical, "utf8"), ts.ScriptTarget.Latest, true);
    assert.equal(source.parseDiagnostics.length, 0, `${file}: syntax error`);
    assert.equal(source.referencedFiles.length, 0, `${file}: path reference directives are forbidden`);
    for (const ref of source.typeReferenceDirectives) assert.ok(["node", "react", "react-dom", "next"].includes(ref.fileName), `${file}: forbidden type reference ${ref.fileName}`);
    function inspect(node) {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier.text;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal.text;
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression?.text;
      if (specifier) {
        if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("@shared/")) {
          const target = specifier.startsWith("@/") ? resolve(web, specifier.slice(2)) : specifier.startsWith("@shared/") ? resolve(shared, specifier.slice(8)) : resolve(dirname(canonical), specifier);
          const stem = target.replace(/\.[cm]?js$/, "");
          const found = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.mjs`, `${target}.d.mts`, `${target}.d.ts`, `${stem}.ts`, `${stem}.d.mts`, `${stem}.d.ts`, resolve(target, "index.ts")].find(p => existsSync(p) && statSync(p).isFile());
          assert.ok(found, `${file}: unresolved type import ${specifier}`); visit(found);
        } else assert.ok(canonical === resolve(web, "lib/gateway-http.mjs") && ["undici/lib/dispatcher/agent.js", "undici/lib/dispatcher/client.js", "undici/lib/web/fetch/index.js"].includes(specifier)
          || canonical === resolve(web, "lib/gateway-http.d.mts") && ["undici/types/agent", "undici/types/client", "undici/types/fetch", "undici/types/dispatcher"].includes(specifier)
          || specifier.startsWith("node:") || ["react", "react-dom", "next", "next/server", "next/headers", "next/image", "next/link", "next/navigation", "next/dynamic", "next/og", "lucide-react", "next-themes", "react-markdown", "remark-gfm", "undici", "mdast", "unist", "hast", "unified"].includes(specifier), `${file}: forbidden type import ${specifier}`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  for (const file of files) visit(resolve(root, file));
  return [...visited].map(p => normalize(relative(root, p))).sort();
}
export function checkNextEntryBoundary(root = ROOT, ts = createRequire(resolve(ROOT, "web/package.json"))("typescript")) {
  const roots = nextEntryRoots(root), startup = checkNextStartupBoundary(root, ts);
  const graph = checkNextTransportBoundary(root, ts, roots, "entry", true);
  const files = typeClosure(root, graph.files, ts);
  return { roots: roots.length, routes: roots.filter(p => /\/route\.[jt]sx?$/.test(p)).length, modules: graph.modules, typeModules: files.length, startupModules: startup.modules, entries: roots, files };
}
/** Exact discovered roots avoid compiling unused legacy compatibility wrappers/tests. */
export function productionTypeConfig(entries) {
  return { extends: "./tsconfig.build.json", compilerOptions: { incremental: false, paths: { "@/*": ["./src/*"], "@shared/*": ["./shared/*", "../shared/*"] } }, include: [...entries.map(p => p.replace(/^web\//, "")), "next-env.d.ts", ".next/types/**/*.ts"], exclude: ["node_modules", "**/*.test.ts", "**/*.test.tsx"] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { entries, files, ...result } = checkNextEntryBoundary(); console.log("All Next entry boundary:", result); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
