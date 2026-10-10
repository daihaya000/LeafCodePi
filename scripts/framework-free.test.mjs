import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkFrameworkFree } from "./framework-free.mjs";

test("the checkout has no framework package, configuration, source import or test mock", () => {
  const checked = checkFrameworkFree(); assert.equal(checked.manifests, 9); assert.ok(checked.sources > 1000);
});
test("framework declarations, literal dynamic loaders, mocks, config and lock resurrection fail closed", t => {
  const root = mkdtempSync(join(tmpdir(), "framework-negative-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "web/src"), { recursive: true }); const source = join(root, "web/src/fixture.ts");
  for (const code of ['import type { Metadata } from "next";', 'export { value } from "next/server";', 'type Hidden = import("next/navigation");', 'import("next/link");', 'require("next");', 'vi.mock("next/server", () => ({}));', 'declare module "next" {}']) {
    writeFileSync(source, code); assert.throws(() => checkFrameworkFree(root), /framework import\/mock/);
  }
  writeFileSync(source, 'const rejectionData = `import "next/server"`;'); assert.doesNotThrow(() => checkFrameworkFree(root));
  for (const payload of [{ dependencies: { next: "1" } }, { devDependencies: { "eslint-config-next": "1" } }, { overrides: { next: {} } }, { overrides: { indirect: { next: "1" } } }, { dependencies: { alias: "npm:next@16" } }, { scripts: { build: "next build" } }, { packages: { "node_modules/@next/swc-win32-x64-msvc": {} } }]) {
    writeFileSync(join(root, "web/package.json"), JSON.stringify(payload)); assert.throws(() => checkFrameworkFree(root), /framework/);
  }
  writeFileSync(join(root, "web/package.json"), "{}");
  writeFileSync(join(root, "web/tsconfig.json"), '{"compilerOptions":{"plugins":[{"name":"next"}]}}'); assert.throws(() => checkFrameworkFree(root), /framework config/); rmSync(join(root, "web/tsconfig.json"));
  writeFileSync(join(root, "web/next.config.cjs"), "module.exports = {}"); assert.throws(() => checkFrameworkFree(root), /Removed framework file/); rmSync(join(root, "web/next.config.cjs"));
  rmSync(source); rmSync(join(root, "web/src"), { recursive: true });
  const target = join(root, "linked"); mkdirSync(target); writeFileSync(join(target, "fixture.ts"), 'import "next";');
  symlinkSync(target, join(root, "web/src"), process.platform === "win32" ? "junction" : "dir"); assert.throws(() => checkFrameworkFree(root), /Linked framework audit directory/);
});
