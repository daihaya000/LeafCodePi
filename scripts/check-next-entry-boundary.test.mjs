import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkNextEntryBoundary, nextEntryRoots, productionTypeConfig } from "./check-next-entry-boundary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url))), ts = createRequire(join(ROOT, "web/package.json"))("typescript");
function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-next-entry-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "web/src/app"), { recursive: true }); mkdirSync(join(root, "shared"));
  for (const [p, source] of Object.entries({ "web/src/instrumentation.ts": "export const register = () => {};", "web/src/app/layout.tsx": "export default function Layout(){return null;}", ...files })) { const file=join(root,p); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,source); }
  return root;
}
const check = root => checkNextEntryBoundary(root, ts);
test("every production entry and its type closure is Web/shared-only", () => { const r=check(ROOT); assert.equal(r.routes,167); assert.ok(r.roots>300 && r.modules>500 && r.typeModules>r.modules); assert.equal(r.startupModules,2); });
test("new API routes, nested metadata, render conventions and commented client directives are automatically roots", t => {
  const root=fixture(t,{"web/src/app/api/new/nested/route.ts":"export const GET=()=>{};","web/src/app/(group)/sitemap.ts":"export default ()=>[];","web/src/app/icon.tsx":"export default ()=>null;","web/src/app/(group)/error.tsx":"export default ()=>null;","web/src/widget.tsx":"/* client helper */\n// second comment\n'use client'; export const Widget=()=>null;","web/src/app/api/new/route.test.ts":"import '@backend-runtime/owner';"});
  assert.equal(check(root).routes,1); assert.ok(nextEntryRoots(root).includes("web/src/widget.tsx")); assert.equal(check(root).roots,7);
});
test("an unlisted future route cannot regain an owner runtime, SDK, filesystem or process", t => {
  const root=fixture(t,{"web/src/app/api/future/route.ts":"","shared/helper.ts":""});
  for(const name of ["@backend-runtime/lib/pi/harness","@backend-core/app-store.mjs","@extensions/owner","@earendil-works/pi-ai","better-sqlite3","node:fs","node:child_process"]){writeFileSync(join(root,"web/src/app/api/future/route.ts"),"export * from '@shared/helper';");writeFileSync(join(root,"shared/helper.ts"),`import '${name}';`);assert.throws(()=>check(root),/forbidden transport import/);}
});
test("public types never resolve through Backend, SDK or extension wrappers", t => {
  const root=fixture(t,{"web/src/app/page.tsx":"import type {Dto} from '@/dto'; export default ()=>null;","web/src/dto.ts":""});
  for(const name of ["@backend-runtime/lib/owner","@backend-core/owner.mjs","@earendil-works/pi-ai","@extensions/owner"]){writeFileSync(join(root,"web/src/dto.ts"),`export type {Dto} from '${name}';`);assert.throws(()=>check(root),/forbidden type import/);}
});
test("declarations beside shared mjs implementations cannot conceal owner type dependencies", t => {
  const root=fixture(t,{"web/src/app/api/new/route.ts":"export * from '@shared/helper.mjs';","shared/helper.mjs":"export const safe=true;","shared/helper.d.mts":"export type {Dto} from '@backend-core/owner.mjs';"});assert.throws(()=>check(root),/forbidden type import/);
});
test("import type queries, import-equals and triple-slash type/path escapes are rejected", t => {
  const root=fixture(t,{"web/src/app/page.tsx":""});
  for(const source of ["type T=typeof import('@earendil-works/pi-ai');","import type T=require('@backend-core/owner');","/// <reference path='../../../backend/owner.ts' />\nexport {};","/// <reference types='@earendil-works/pi-ai' />\nexport {};"]){writeFileSync(join(root,"web/src/app/page.tsx"),source);assert.throws(()=>check(root),/forbidden|owner code/);}
});
test("indirect loaders and runtime code evaluation cannot bypass the module gate", t => {
  const root=fixture(t,{"web/src/app/api/new/route.ts":""});
  for(const source of ["const load=require; load('node:fs');","module.require('node:fs');","globalThis['require']('node:fs');","process.getBuiltinModule('fs');","process['getBuiltinModule']('child_process');","(0,eval)('require(\"node:fs\")');","new Function('return require(\"node:fs\")')();"]){writeFileSync(join(root,"web/src/app/api/new/route.ts"),source);assert.throws(()=>check(root),/indirect module/);}
});
test("startup node:http exception does not grant HTTP server access to a route", t => {
  const root=fixture(t,{"web/src/instrumentation.ts":"import './lib/http-compression-fix';","web/src/lib/http-compression-fix.ts":"import 'node:http';","web/src/app/api/new/route.ts":"import 'node:http';"});assert.throws(()=>check(root),/forbidden transport import/);writeFileSync(join(root,"web/src/app/api/new/route.ts"),"export const GET=()=>{};");assert.equal(check(root).startupModules,2);
});
test("entry directories and type-only relative edges cannot escape through junctions", t => {
  const root=fixture(t,{"backend/owner.ts":"export type Dto=string;","web/src/app/page.tsx":"import type {Dto} from '../../../backend/owner';"});assert.throws(()=>check(root),/owner code/);writeFileSync(join(root,"web/src/app/page.tsx"),"export default ()=>null;");symlinkSync(join(root,"backend"),join(root,"web/src/app/escape"),process.platform==="win32"?"junction":"dir");assert.throws(()=>check(root),/redirected|redirect/);
});
test("production typecheck includes only discovered entries, never all legacy wrappers or owner aliases", () => { const cfg=productionTypeConfig(["web/src/instrumentation.ts","web/src/app/page.tsx"]);assert.deepEqual(cfg.compilerOptions.paths,{"@/*":["./src/*"],"@shared/*":["./shared/*","../shared/*"]});assert.ok(!cfg.include.includes("**/*.ts"));assert.ok(cfg.include.includes("src/app/page.tsx")); });
test("production build gate precedes output replacement and never provisions Backend extensions", () => { const s=readFileSync(join(ROOT,"scripts/build-web.mjs"),"utf8"),body=s.slice(s.indexOf("export async function main("));assert.ok(body.indexOf("checkNextEntryBoundary(REPO_ROOT, ts)")>body.indexOf("ensureBuildDependencies(mirror.mirrorRoot)"));assert.ok(body.indexOf("stashPreviousBuild(mirror.distDir)")>body.indexOf("checkNextEntryBoundary(REPO_ROOT, ts)"));assert.doesNotMatch(body,/ensureExtensionDependencies\(|assertPiDependencyVersions\(/);assert.match(body,/productionTypeConfig\(boundary.entries\)/); assert.ok(body.indexOf("const generatedTypesStatus = await spawnPiped(typecheck.command")>body.indexOf("await spawnPiped(process.execPath, nextArgs")); assert.doesNotMatch(body,/skipping the typecheck gate/); });
