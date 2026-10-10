import { build, preview } from "vite";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import config, { spaBoundary } from "../../vite.config";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-spa-boundary-")); directories.push(root);
  await writeFile(join(root, "index.html"), '<html><body><script type="module" src="/entry.js"></script></body></html>');
  await writeFile(join(root, "entry.js"), source); return root;
}
async function buildFixture(root: string) { return build({ ...config, configFile: false, root, publicDir: false, logLevel: "silent", build: { outDir: "out", emptyOutDir: true } }); }
async function sourceText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceText(join(root, entry.name)) : readFile(join(root, entry.name), "utf8")))).join("\n");
}
describe("SPA production boundary", () => {
  it.each(["node:fs", "fs", "fs/promises", "next/server", "@earendil-works/pi-coding-agent", "@backend-core/task-store", "@extensions/leafcode-goal-loop"])("rejects runtime import %s", async id => {
    const root = await fixture(`import '${id}'; document.body.textContent = 'fixture';`);
    await expect(buildFixture(root)).rejects.toThrow("SPA runtime dependency forbidden");
  });
  it("rejects resolved owner, API and Next module IDs", () => {
    const plugin = spaBoundary();
    const hook = plugin.generateBundle as (options: unknown, bundle: unknown) => void;
    for (const id of ["C:/repo/backend/src/index.mjs", "C:/repo/web/src/app/api/tasks/route.ts", "C:/repo/web/node_modules/next/dist/index.js"]) {
      expect(() => hook({}, { main: { type: "chunk", modules: { [id]: {} } } })).toThrow("forbidden");
    }
  });
  it("does not expose VITE_* or owner credentials to HTML/JS", async () => {
    const previousVite = process.env.VITE_FIXTURE_SECRET, previousOwner = process.env.LEAFCODE_PI_BACKEND_TOKEN;
    const canary = "spa-canary-not-a-real-credential";
    process.env.VITE_FIXTURE_SECRET = canary; process.env.LEAFCODE_PI_BACKEND_TOKEN = canary;
    try {
      const root = await fixture('document.body.textContent = JSON.stringify([import.meta.env.VITE_FIXTURE_SECRET, import.meta.env.LEAFCODE_PI_BACKEND_TOKEN]);');
      await buildFixture(root); expect(await sourceText(join(root, "out"))).not.toContain(canary);
    } finally {
      if (previousVite === undefined) delete process.env.VITE_FIXTURE_SECRET; else process.env.VITE_FIXTURE_SECRET = previousVite;
      if (previousOwner === undefined) delete process.env.LEAFCODE_PI_BACKEND_TOKEN; else process.env.LEAFCODE_PI_BACKEND_TOKEN = previousOwner;
    }
  });
  it("production preview serves every direct/reloaded URL and forwards API only to the isolated fixture", async () => {
    const output = await mkdtemp(join(tmpdir(), "leafcode-spa-production-")); directories.push(output);
    await build({ ...config, configFile: false, logLevel: "silent", build: { outDir: output, emptyOutDir: true } });
    const owner = createServer((request, response) => { expect(request.url).toBe("/api/settings?fixture=1"); response.setHeader("content-type", "application/json"); response.end('{"values":{"fixture":"saved"}}'); });
    await new Promise<void>(done => owner.listen(0, "127.0.0.1", done));
    const ownerAddress = owner.address(); if (!ownerAddress || typeof ownerAddress === "string") throw Error("Fixture did not listen");
    const server = await preview({ ...config, configFile: false, logLevel: "silent", build: { outDir: output }, preview: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: `http://127.0.0.1:${ownerAddress.port}`, changeOrigin: false } } } });
    try {
      const address = server.httpServer.address(); if (!address || typeof address === "string") throw Error("Preview did not listen");
      const origin = `http://127.0.0.1:${address.port}`, expected = await readFile(join(output, "index.html"), "utf8");
      for (const path of ["/", "/task/task-a", "/settings", "/bots", "/bots/bot-a", "/bots/rooms/room-a", "/login"]) {
        for (let reload = 0; reload < 2; reload++) { const response = await fetch(`${origin}${path}?fixture=1`); expect(response.status).toBe(200); expect(await response.text()).toBe(expected); }
      }
      expect(await (await fetch(`${origin}/api/settings?fixture=1`)).json()).toEqual({ values: { fixture: "saved" } });
      expect((await fetch(`${origin}/icon.svg`)).status).toBe(200);
    } finally { await new Promise<void>((done, reject) => server.httpServer.close(error => error ? reject(error) : done())); await new Promise<void>((done, reject) => owner.close(error => error ? reject(error) : done())); }
  }, 25_000);
});
