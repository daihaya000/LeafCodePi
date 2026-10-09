import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { checkNextUiBoundary, nextUiRoots } from "./check-next-ui-boundary.mjs";
function fixture(t, files) { const root = mkdtempSync(join(tmpdir(), "leafcode-ui-boundary-")); t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(join(root, "shared")); for (const [path, source] of Object.entries(files)) { const f = join(root, path); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, source); } return root; }
test("all actual UI render/client roots have no owner/SDK/filesystem/process value imports", () => { const value = checkNextUiBoundary(); assert.ok(value.roots > 100); assert.ok(value.modules > 300); });
test("auto discovers server render conventions and client directives; excludes tests and API routes", t => {
 const root = fixture(t, { "web/src/app/layout.tsx": "export const x=1", "web/src/app/page.tsx": "export const x=1", "web/src/app/(group)/template.tsx": "export const x=1", "web/src/components/Thing.tsx": "'use client'; export const x=1", "web/src/owner.test.tsx": "'use client'; import 'node:fs'", "web/src/app/api/private/route.ts": "import 'node:fs'" }); assert.equal(nextUiRoots(root).length, 4); assert.equal(checkNextUiBoundary(root).modules, 4);
});
test("UI framework and static CSS are admitted, relative shared transitive owner imports fail closed", t => {
 const root = fixture(t, { "web/src/app/layout.tsx": "import 'react'; import 'next/headers'; import './globals.css'; import '@shared/ui/helper';", "web/src/app/globals.css": "body { margin:0 }", "shared/ui/helper.ts": "export const pure=true" }); assert.equal(checkNextUiBoundary(root).modules, 3);
 for (const bad of ["@earendil-works/pi-ai", "@backend-runtime/lib/pi/harness", "node:fs", "node:child_process", "better-sqlite3"]) { writeFileSync(join(root, "shared/ui/helper.ts"), `import '${bad}'`); assert.throws(() => checkNextUiBoundary(root), /forbidden transport import/); }
});
test("only the root layout's static hostname read is permitted, not other OS capabilities or dynamic loading", t => {
 const root = fixture(t, { "web/src/app/layout.tsx": "import { hostname } from 'node:os'; export const name=hostname()" }); assert.equal(checkNextUiBoundary(root).modules, 1);
 for (const code of ["import { homedir } from 'node:os'", "const m=require('node:os')", "import * as os from 'node:os'"]) { writeFileSync(join(root, "web/src/app/layout.tsx"), code); assert.throws(() => checkNextUiBoundary(root)); }
});
test("Web build checks all UI roots before .next replacement", () => { const s=readFileSync(new URL("./build-web.mjs",import.meta.url),"utf8"),b=s.slice(s.indexOf("export async function main(")); assert.ok(b.indexOf("checkNextUiBoundary(REPO_ROOT, ts)") > b.indexOf("ensureBuildDependencies(mirror.mirrorRoot)")); assert.ok(b.indexOf("checkNextUiBoundary(REPO_ROOT, ts)") < b.indexOf("stashPreviousBuild(mirror.distDir)")); });
