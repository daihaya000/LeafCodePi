import { build, loadEnv, preview, type InlineConfig } from "vite";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import config, { spaBoundary } from "../../vite.config";
import { createSecretCanaries, scanCanaryArtifacts, withCanaryEnvironment } from "../../../scripts/spa-secret-canary.mjs";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-spa-boundary-")); directories.push(root);
  await writeFile(join(root, "index.html"), '<html><body><script type="module" src="/entry.js"></script></body></html>');
  await writeFile(join(root, "entry.js"), source); return root;
}
async function buildFixture(root: string, overrides: InlineConfig = {}) { return build({ ...config, ...overrides, configFile: false, root, publicDir: false, logLevel: "silent", build: { outDir: "out", emptyOutDir: true, ...overrides.build } }); }
async function sourceText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceText(join(root, entry.name)) : readFile(join(root, entry.name), "utf8")))).join("\n");
}
describe("SPA production boundary", () => {
  it.each(["node:fs", "fs", "fs/promises", "next/server", "next/navigation", "next/link", "next/image", "next/dynamic", "@earendil-works/pi-coding-agent", "@backend-core/task-store", "@extensions/leafcode-goal-loop", "@shared/webui-presentation.mjs"])("rejects runtime import %s", async id => {
    const root = await fixture(`import '${id}'; document.body.textContent = 'fixture';`);
    await expect(buildFixture(root)).rejects.toThrow("SPA runtime dependency forbidden");
  });
  it("rejects resolved owner, API and Next module IDs", () => {
    const plugin = spaBoundary();
    const hook = plugin.generateBundle as (options: unknown, bundle: unknown) => void;
    for (const id of ["C:/repo/backend/src/index.mjs", "C:/repo/web/src/app/api/tasks/route.ts", "C:/repo/web/node_modules/next/dist/index.js", ...["navigation", "link", "image", "dynamic"].map(name => `C:/repo/web/src/platform/${name}.ts`)]) {
      expect(() => hook({}, { main: { type: "chunk", modules: { [id]: {} } } })).toThrow("forbidden");
    }
  });
  it("binds every neutral UI import to React adapters without loading legacy Next bridges", async () => {
    const root = await fixture(`import * as navigation from '@/spa/navigation'; import Link from '@/spa/link'; import Image from '@/spa/image'; import dynamic from '@/spa/dynamic'; document.body.platform = [navigation, Link, Image, dynamic];`);
    // React dedupe resolves from the configured fixture root, not the importer.
    await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const modules: string[] = [];
    await buildFixture(root, { plugins: [spaBoundary(), { name: "capture-platform-modules", moduleParsed(module) {
      // Pure re-export adapters can be omitted from rendered chunks by tree-shaking.
      // Capture the parsed graph, while spaBoundary still audits emitted chunks.
      modules.push(module.id.replaceAll("\\", "/"));
    } }] });
    for (const name of ["navigation.tsx", "link.ts", "image.ts", "dynamic.ts"]) expect(modules.some(id => id.endsWith(`/src/spa/${name}`))).toBe(true);
    expect(modules.some(id => /\/src\/platform\/|\/node_modules\/next\//.test(id))).toBe(false);
  });
  it("keeps shared UI source free of direct Next imports, re-exports and dynamic loading", async () => {
    const src = fileURLToPath(new URL("../", import.meta.url));
    const violations: string[] = [];
    async function scan(path: string): Promise<void> {
      const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
          : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteralLike(specifier) && /^next(?:\/|$)/.test(specifier.text)) violations.push(`${path}: ${specifier.text}`);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    async function walk(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (/\.[jt]sx?$/.test(file) && !/\.test\./.test(file)) await scan(file);
      }
    }
    await walk(resolve(src, "components")); await walk(resolve(src, "spa"));
    await scan(resolve(src, "app/login/LoginForm.tsx"));
    expect(violations).toEqual([]);
  });
  it("keeps whole/named env and HTML placeholders secret across all dotenv layers and source maps", async () => {
    const canaries = createSecretCanaries();
    const names = [...new Set(canaries.entries.map(entry => entry.name))];
    const fields = names.map(name => `${name}: [import.meta.env.${name}, process.env.${name}]`).join(",");
    const root = await fixture(`document.body.textContent = JSON.stringify({ whole: import.meta.env, ${fields} });`);
    for (const [filename, content] of Object.entries(canaries.files)) await writeFile(join(root, filename), content as string);
    await writeFile(join(root, "index.html"), '<html><head><meta content="%VITE_SECRET% %VITE_DOTENV_PRECEDENCE_TOKEN% %LEAFCODE_PI_WEBUI_TOKEN%"></head><body><script type="module" src="/entry.js"></script></body></html>');
    await withCanaryEnvironment(canaries, async () => {
      // Prove inputs were loaded, rather than passing because no secret was injected.
      const loaded = loadEnv("production", root, "");
      for (const entry of canaries.entries.filter(entry => entry.name !== "VITE_DOTENV_PRECEDENCE_TOKEN")) expect(loaded[entry.name] === entry.value).toBe(true);
      expect(loaded.VITE_DOTENV_PRECEDENCE_TOKEN === canaries.entries.at(-1)?.value).toBe(true);
      await buildFixture(root, { build: { sourcemap: true } });
    });
    const result = await scanCanaryArtifacts(join(root, "out"), canaries.entries);
    expect(result.maps).toBeGreaterThan(0);
    expect(await sourceText(join(root, "out"))).toContain("%VITE_SECRET%");
  });
  it("the audit detects an accidentally restored VITE_ exposure prefix", async () => {
    const canaries = createSecretCanaries();
    const root = await fixture('document.body.textContent = JSON.stringify(import.meta.env);');
    await withCanaryEnvironment(canaries, () => buildFixture(root, { envPrefix: ["VITE_"] }));
    await expect(scanCanaryArtifacts(join(root, "out"), canaries.entries)).rejects.toThrow("SPA secret canary leaked");
  });
  it("production preview serves every direct/reloaded URL and forwards API only to the isolated fixture", async () => {
    const output = await mkdtemp(join(tmpdir(), "leafcode-spa-production-")); directories.push(output);
    // Match the production worker, not Vitest's development React stack/code-generation helpers.
    const previous = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { await build({ ...config, configFile: false, logLevel: "silent", build: { outDir: output, emptyOutDir: true } }); }
    finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
    const owner = createServer((request, response) => { expect(["/api/settings?fixture=1", "/webui-bootstrap.json?fixture=1"]).toContain(request.url); response.setHeader("content-type", "application/json"); response.end(request.url?.startsWith("/webui-bootstrap.json") ? '{"hostname":"fixture-host","authFileDisplayPath":"/fixture/webui-auth.json"}' : '{"values":{"fixture":"saved"}}'); });
    await new Promise<void>(done => owner.listen(0, "127.0.0.1", done));
    const ownerAddress = owner.address(); if (!ownerAddress || typeof ownerAddress === "string") throw Error("Fixture did not listen");
    const server = await preview({ ...config, configFile: false, logLevel: "silent", build: { outDir: output }, preview: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: `http://127.0.0.1:${ownerAddress.port}`, changeOrigin: false }, "^/webui-bootstrap\\.json(?:\\?|$)": { target: `http://127.0.0.1:${ownerAddress.port}`, changeOrigin: false } } } });
    try {
      const address = server.httpServer.address(); if (!address || typeof address === "string") throw Error("Preview did not listen");
      const origin = `http://127.0.0.1:${address.port}`, expected = await readFile(join(output, "index.html"), "utf8");
      for (const path of ["/", "/task/task-a", "/settings", "/bots", "/bots/bot-a", "/bots/rooms/room-a", "/login"]) {
        for (let reload = 0; reload < 2; reload++) { const response = await fetch(`${origin}${path}?fixture=1`); expect(response.status).toBe(200); expect(await response.text()).toBe(expected); }
      }
      expect(await (await fetch(`${origin}/api/settings?fixture=1`)).json()).toEqual({ values: { fixture: "saved" } });
      expect(await (await fetch(`${origin}/webui-bootstrap.json?fixture=1`)).json()).toEqual({ hostname: "fixture-host", authFileDisplayPath: "/fixture/webui-auth.json" });
      expect((await fetch(`${origin}/icon.svg`)).status).toBe(200);
    } finally { await new Promise<void>((done, reject) => server.httpServer.close(error => error ? reject(error) : done())); await new Promise<void>((done, reject) => owner.close(error => error ? reject(error) : done())); }
  }, 90_000);
});
