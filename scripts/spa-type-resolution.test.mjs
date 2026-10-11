import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkProductionBoundary, checkProductionFile } from "./production-boundary.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const ts = createRequire(join(ROOT, "web/package.json"))("typescript");
const put = (root, name, source) => {
  const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file;
};
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), "spa-type-resolution-")), root = join(parent, ".spa/workspace");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(join(root, "web"), { recursive: true });
  for (const name of ["tsconfig.json", "tsconfig.spa.json"]) copyFileSync(join(ROOT, "web", name), join(root, "web", name));
  symlinkSync(join(ROOT, "web/node_modules"), join(root, "web/node_modules"), process.platform === "win32" ? "junction" : "dir");
  const configFile = join(root, "web/tsconfig.spa.json");
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, "web"), undefined, configFile).options;
  return { parent, root, options };
}

test("SPA shared React types and automatic JSX resolve from Web, not legacy mirror ancestors", t => {
  const { parent, root, options } = fixture(t);
  for (const name of ["react", "react-dom"]) {
    put(parent, `node_modules/@types/${name}/package.json`, JSON.stringify({ name: `@types/${name}`, types: "index.d.ts" }));
    put(parent, `node_modules/@types/${name}/index.d.ts`, 'import "next/server"; export {};');
  }
  put(parent, "node_modules/@types/react/jsx-runtime.d.ts", 'import "next/server"; export {};');
  const shared = put(root, "shared/component.tsx", 'import type { ReactNode } from "react"; export const Component = ({ children }: { children: ReactNode }) => <div>{children}</div>;');
  const entry = put(root, "web/src/spa/main.tsx", 'export { Component } from "@shared/component";');
  for (const specifier of ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"]) {
    const local = ts.resolveModuleName(specifier, entry, options, ts.sys).resolvedModule;
    const external = ts.resolveModuleName(specifier, shared, options, ts.sys).resolvedModule;
    assert.ok(local && external, `Unresolved ${specifier}`);
    assert.equal(external.resolvedFileName, local.resolvedFileName, `Shared ${specifier} escaped Web dependencies`);
    assert.ok(external.resolvedFileName.startsWith(realpathSync(join(root, "web/node_modules")).replaceAll("\\", "/") + "/"));
  }
  assert.doesNotThrow(() => checkProductionBoundary(root, "browser", { entries: [entry] }));
  // Fix resolution rather than accepting old ancestor installations at the gate.
  assert.throws(() => checkProductionFile(join(parent, "node_modules/@types/react/jsx-runtime.d.ts"), root, "browser", { packageFile: true }), /package symlink escape/);
});

test("SPA dependency mappings do not authorize arbitrary package junction escapes", t => {
  const { parent, root } = fixture(t);
  const external = put(parent, "outside/index.d.ts", "export interface Secret { value: string }");
  const linked = join(root, "linked/node_modules/browser-helper");
  mkdirSync(dirname(linked), { recursive: true });
  symlinkSync(dirname(external), linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => checkProductionFile(join(linked, "index.d.ts"), root, "browser", { packageFile: true }), /package symlink escape/);
});
