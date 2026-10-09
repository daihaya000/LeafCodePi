import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkNextStartupBoundary, startupImports } from "./check-next-startup-boundary.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-next-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text, "utf8");
  }
  return root;
}

test("checked-in Next lifecycle loads HTTP transport only", () => {
  assert.deepEqual(checkNextStartupBoundary(ROOT), { modules: 2 });
});
test("checker module loads without checkout dependencies and accepts a provisioned compiler", (t) => {
  const root = fixture(t, { "web/src/instrumentation.ts": "import 'node:http';" });
  const relocated = join(root, "checker.mjs");
  copyFileSync(join(ROOT, "scripts/check-next-startup-boundary.mjs"), relocated);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./checker.mjs')"], {
    cwd: root, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const ts = createRequire(join(ROOT, "web/package.json"))("typescript");
  assert.deepEqual(checkNextStartupBoundary(root, ts), { modules: 1 });
});

test("Web build checks startup before replacing the previous .next", () => {
  const source = readFileSync(join(ROOT, "scripts/build-web.mjs"), "utf8");
  const start = source.indexOf("export async function main(");
  const body = source.slice(start);
  const provision = body.indexOf("ensureBuildDependencies(mirror.mirrorRoot)");
  const gate = body.indexOf("checkNextStartupBoundary(REPO_ROOT, ts)");
  const stash = body.indexOf("stashPreviousBuild(mirror.distDir)");
  assert.ok(start > 0 && provision > 0 && gate > provision && stash > gate);
});

test("recognises static, dynamic, re-export and require dependencies but ignores erased types/comments", () => {
  assert.deepEqual(startupImports(`
    import type { Session } from 'owner';
    import { type Session } from 'owner';
    export type { Session } from 'owner';
    // import('fake')
    const text = "import('fake')";
    import 'transport'; export * from './transport';
    const load = () => import('./helper'); require('node:http');
    import http = require('node:http');
  `), ["transport", "./transport", "./helper", "node:http", "node:http"]);
});
test("rejects nonliteral loaders and syntax errors instead of silently skipping them", () => {
  for (const source of ["import(name)", "require(name)", "import(`./${name}`)", "import("]) {
    assert.throws(() => startupImports(source), /nonliteral|syntax/);
  }
});
test("follows alias helpers, re-exports and cycles transitively", (t) => {
  const root = fixture(t, {
    "web/src/instrumentation.ts": "import '@/transport';",
    "web/src/transport.ts": "export * from './helper';",
    "web/src/helper.ts": "import './transport'; import 'node:http';",
  });
  assert.deepEqual(checkNextStartupBoundary(root), { modules: 3 });
});
test("rejects SDK, Backend compatibility imports and OS/file/process helpers at any depth", (t) => {
  const root = fixture(t, { "web/src/instrumentation.ts": "import './helper';", "web/src/helper.ts": "" });
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@backend-runtime/lib/pi/harness", "@backend-core/runtime-startup.mjs", "node:fs", "node:child_process"]) {
    writeFileSync(join(root, "web/src/helper.ts"), `export * from '${name}';`, "utf8");
    assert.throws(() => checkNextStartupBoundary(root), /forbidden startup import/);
  }
});
test("rejects owner code through relative escapes and symlink canonicalisation", (t) => {
  const root = fixture(t, { "web/src/instrumentation.ts": "import '../../backend/owner';", "backend/owner.ts": "" });
  assert.throws(() => checkNextStartupBoundary(root), /owner code/);
  symlinkSync(join(root, "backend"), join(root, "web/src/owner"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, "web/src/instrumentation.ts"), "import './owner/owner';", "utf8");
  assert.throws(() => checkNextStartupBoundary(root), /owner code/);
});
test("rejects missing dependencies and restored legacy startup even if unreachable", (t) => {
  const root = fixture(t, { "web/src/instrumentation.ts": "import './missing';" });
  assert.throws(() => checkNextStartupBoundary(root), /unresolved/);
  mkdirSync(join(root, "web/src/lib/pi"), { recursive: true });
  writeFileSync(join(root, "web/src/lib/pi/runtime-startup.ts"), "", "utf8");
  assert.throws(() => checkNextStartupBoundary(root), /must be removed/);
});
