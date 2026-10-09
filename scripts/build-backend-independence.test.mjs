import assert from "node:assert/strict";
import { statSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertBackendInputs, backendRuntimeSourceStamp, runtimeAliases } from "./build-backend-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("runtime aliases resolve Backend, shared and extension code, never Web", () => {
  assert.equal(runtimeAliases()["@"], join(ROOT, "backend", "runtime-src"));
  for (const path of Object.values(runtimeAliases())) assert.equal(path.replaceAll("\\", "/").includes("/web/"), false);
});

test("metafile guard rejects Web sources and Web node_modules", () => {
  assertBackendInputs({ inputs: { "backend/runtime-src/lib/pi/harness.ts": {}, "shared/types.ts": {} } });
  for (const path of ["web/src/lib/pi/harness.ts", join(ROOT, "web", "node_modules", "yaml", "index.js")]) {
    assert.throws(() => assertBackendInputs({ inputs: { [path]: {} } }), /depends on Web/);
  }
});

test("touching a Web source does not invalidate the Backend bundle stamp", () => {
  const source = join(ROOT, "web", "src", "lib", "pi", "harness.ts");
  const before = backendRuntimeSourceStamp();
  const stat = statSync(source);
  try {
    utimesSync(source, stat.atimeMs / 1000, stat.mtimeMs / 1000 + 2);
    assert.equal(backendRuntimeSourceStamp(), before);
  } finally { utimesSync(source, stat.atimeMs / 1000, stat.mtimeMs / 1000); }
});

test("Backend owns its compiler, provider and native SQLite dependencies", () => {
  const require = createRequire(join(ROOT, "backend", "package.json"));
  for (const name of ["esbuild", "typescript", "jiti", "yaml", "typebox", "undici", "@rahularya01/pi-cursor", "pi-commandcode-provider", "better-sqlite3"]) {
    assert.equal(require.resolve(name === "pi-commandcode-provider" ? `${name}/package.json` : name).replaceAll("\\", "/").includes("/web/"), false, name);
  }
  const Sqlite = require("better-sqlite3");
  const db = new Sqlite(":memory:");
  try { assert.equal(db.prepare("SELECT 1 AS value").get().value, 1); } finally { db.close(); }
});
