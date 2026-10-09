import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkNextTransportBoundary, NEXT_TRANSPORT_ROOTS } from "./check-next-transport-boundary.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["web/src/entry.ts"];
function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-next-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "web/src"), { recursive: true });
  mkdirSync(join(root, "shared"));
  for (const [path, source] of Object.entries(files)) {
    const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source, "utf8");
  }
  return root;
}
const check = (root) => checkNextTransportBoundary(root, undefined, ENTRIES);

test("migrated Next ingress closes over Web/shared auth and transport, never Backend/SDK", () => {
  const result = checkNextTransportBoundary(ROOT);
  assert.equal(result.roots, NEXT_TRANSPORT_ROOTS.length);
  assert.ok(result.modules > 40, "the actual shared .mjs implementations must be checked too");
});
test("build gates transport after compiler provisioning and before replacing .next", () => {
  const source = readFileSync(join(ROOT, "scripts/build-web.mjs"), "utf8");
  const body = source.slice(source.indexOf("export async function main("));
  const provision = body.indexOf("ensureBuildDependencies(mirror.mirrorRoot)");
  const gate = body.indexOf("checkNextTransportBoundary(REPO_ROOT, ts)");
  const stash = body.indexOf("stashPreviousBuild(mirror.distDir)");
  assert.ok(provision > 0 && gate > provision && stash > gate);
});
test("shared aliases, relative imports, reexports, dynamic imports and cycles are checked", (t) => {
  const root = fixture(t, {
    "web/src/entry.ts": "import '@/helper';",
    "web/src/helper.ts": "export * from '@shared/wire.mjs';",
    "shared/wire.mjs": "import '../web/src/helper'; const load = () => import('./payload.mjs');",
    "shared/payload.mjs": "import 'node:crypto'; require('undici');",
  });
  assert.deepEqual(check(root), { roots: 1, modules: 4 });
});
test("type-only dependencies/comments/strings are not runtime imports", (t) => {
  const root = fixture(t, { "web/src/entry.ts": `
    import type { Session } from '@backend-runtime/owner';
    import { type Session } from '@earendil-works/pi-ai';
    export type { Session } from '@backend-core/owner.mjs';
    type Loader = typeof import('@backend-runtime/owner');
    // require('node:fs')
    const text = "import('node:child_process')";
  ` });
  assert.deepEqual(check(root), { roots: 1, modules: 1 });
});
test("a shared .d.mts never hides the prohibited imports of the matching .mjs", (t) => {
  const root = fixture(t, {
    "web/src/entry.ts": "export * from '@shared/wire.mjs';",
    "shared/wire.d.mts": "export const safe: true;",
    "shared/wire.mjs": "import '@backend-core/app-store.mjs';",
  });
  assert.throws(() => check(root), /forbidden transport import/);
});
test("rejects owner/SDK/native/state/process/network helpers transitively", (t) => {
  const root = fixture(t, { "web/src/entry.ts": "import '@shared/wire.mjs';", "shared/wire.mjs": "" });
  for (const module of ["@backend-runtime/lib/pi/harness", "@backend-core/app-store.mjs", "@extensions/owner",
    "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "better-sqlite3", "node:child_process", "node:fs", "node:http", "node:net", "node:os"]) {
    writeFileSync(join(root, "shared/wire.mjs"), `export * from '${module}';`, "utf8");
    assert.throws(() => check(root), /forbidden transport import/, module);
  }
});
test("generation metadata admits only one named readFileSync, no default/write/dynamic fs", (t) => {
  const root = fixture(t, {
    "web/src/entry.ts": "import '@shared/backend-http-client';",
    "shared/backend-http-client.ts": "import { readFileSync } from 'node:fs';",
  });
  assert.deepEqual(check(root), { roots: 1, modules: 2 });
  for (const source of ["import { writeFileSync } from 'node:fs';", "import fs from 'node:fs';",
    "import { readFileSync, writeFileSync } from 'node:fs';", "require('node:fs');", "import('node:fs');"]) {
    writeFileSync(join(root, "shared/backend-http-client.ts"), source, "utf8");
    assert.throws(() => check(root), /generation|filesystem/);
  }
});
test("rejects nonliteral loaders, syntax errors, unresolved modules and executable declarations", (t) => {
  const root = fixture(t, { "web/src/entry.ts": "", "shared/wire.d.mts": "export const data: true;" });
  for (const source of ["require(name)", "import(`./${name}`)", "import(", "import './missing'", "import '@shared/wire.d.mts'"]) {
    writeFileSync(join(root, "web/src/entry.ts"), source, "utf8");
    assert.throws(() => check(root), /nonliteral|syntax|unresolved|Declaration/);
  }
});
test("rejects relative owner escapes and directory junctions outside Web/shared", (t) => {
  const root = fixture(t, { "web/src/entry.ts": "import '../../backend/owner';", "backend/owner.ts": "" });
  assert.throws(() => check(root), /owner code/);
  symlinkSync(join(root, "backend"), join(root, "web/src/owner"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, "web/src/entry.ts"), "import './owner/owner';", "utf8");
  assert.throws(() => check(root), /owner code/);
});
test("rejects redirecting the entire shared root to Backend", (t) => {
  const root = fixture(t, { "web/src/entry.ts": "import '@shared/owner';", "backend/owner.ts": "" });
  rmSync(join(root, "shared"), { recursive: true });
  symlinkSync(join(root, "backend"), join(root, "shared"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => check(root), /cannot redirect/);
});
test("checker imports without checkout TypeScript and accepts a provisioned compiler", (t) => {
  const root = fixture(t, { "web/src/entry.ts": "import 'node:crypto';" });
  for (const name of ["check-next-startup-boundary.mjs", "check-next-transport-boundary.mjs"]) {
    copyFileSync(join(ROOT, "scripts", name), join(root, name));
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./check-next-transport-boundary.mjs')"],
    { cwd: root, encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  const ts = createRequire(join(ROOT, "web/package.json"))("typescript");
  assert.deepEqual(checkNextTransportBoundary(root, ts, ENTRIES), { roots: 1, modules: 1 });
});
