import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createDevelopmentGateway } from "../gateway/src/development.mjs";
import { collectRoutes } from "./check-api-ownership.mjs";
import { startFixture } from "./spa-browser-fixture.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url))), require = createRequire(join(ROOT, "web/package.json"));
const { createServer: createViteServer } = await import(pathToFileURL(require.resolve("vite")).href), { chromium } = require("playwright");
async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }

test("cold actual SPA renders six protected screens through gateway, serves only canonical optimizer JS and hot-updates CSS", { timeout: 180000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "spa-dev-real-")), webRoot = join(root, "web"), staticRoot = join(root, "sealed/spa"), scratchRoot = join(root, "mirror/.spa");
  const old = { ...process.env }, dependencyLink = join(webRoot, "node_modules"); let fixture, dev, browser;
  t.after(async () => {
    await browser?.close(); await dev?.close(); await fixture?.close();
    if (existsSync(dependencyLink)) unlinkSync(dependencyLink);
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old);
    rmSync(root, { recursive: true, force: true });
  });
  for (const dir of [webRoot, join(staticRoot, "assets"), scratchRoot]) mkdirSync(dir, { recursive: true });
  for (const name of ["src", "public", "index.html", "vite.config.ts", "postcss.config.mjs", "package.json"]) cpSync(join(ROOT, "web", name), join(webRoot, name), { recursive: true });
  cpSync(join(ROOT, "shared"), join(root, "shared"), { recursive: true });
  for (const file of ["production-boundary.mjs", "check-api-ownership.mjs", "gateway-contracts.json"]) {
    mkdirSync(join(root, "scripts"), { recursive: true }); cpSync(join(ROOT, "scripts", file), join(root, "scripts", file));
  }
  symlinkSync(join(ROOT, "web/node_modules"), dependencyLink, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(staticRoot, "index.html"), '<html><h1>sealed public Login</h1><script type="module" src="/assets/index-Abc123_-.js"></script></html>');
  writeFileSync(join(staticRoot, "assets/index-Abc123_-.js"), "export {};");
  const cssFile = join(webRoot, "src/app/globals.css"), css = readFileSync(cssFile, "utf8"); writeFileSync(cssFile, css + "\n:root { --p3-dev-hot: before; }\n");
  process.env.LEAFCODE_PI_DATA_DIR = join(root, "data"); process.env.LEAFCODE_PI_WEBUI_AUTH = "required"; process.env.LEAFCODE_PI_WEBUI_TOKEN = "finite-real-spa-token";
  fixture = await startFixture({ dataDir: process.env.LEAFCODE_PI_DATA_DIR });
  const records = [...collectRoutes(ROOT)].map(([route, record]) => ({ route, methods: record.methods, load: async () => Object.fromEntries(record.methods.map(method => [method, async request => {
    const url = new URL(request.url), upstream = await fetch(fixture.origin + url.pathname + url.search, { method: request.method, headers: request.headers, signal: request.signal,
      ...(!["GET", "HEAD"].includes(request.method) ? { body: await request.arrayBuffer() } : {}) });
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  }])) }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`, cookie = "leafcode-pi-token=finite-real-spa-token", headers = { cookie };
  dev = await createDevelopmentGateway(records, { createViteServer, webRoot, staticRoot, scratchRoot, hostname: "127.0.0.1", port, configFile: join(webRoot, "vite.config.ts"), logLevel: "silent" });
  await new Promise(r => dev.server.listen(port, "127.0.0.1", r));
  assert.equal(dev.vite.httpServer, null); assert.equal(dev.privateHmr.listening, false);
  browser = await chromium.launch({ headless: true, ...(process.env.LEAFCODE_TEST_CHROMIUM ? { executablePath: process.env.LEAFCODE_TEST_CHROMIUM } : {}) });
  const context = await browser.newContext(); await context.addCookies([{ name: "leafcode-pi-token", value: "finite-real-spa-token", url: base }]);
  const page = await context.newPage(), errors = [], failed = [], modules = [], sockets = [];
  page.on("pageerror", error => errors.push(error.stack ?? error.message)); page.on("requestfailed", request => { if (!request.url().includes("/events")) failed.push({ url: request.url(), error: request.failure()?.errorText }); });
  page.on("response", response => { if (response.status() >= 400) console.log("real-spa: resource failure", response.status(), new URL(response.url()).pathname); if (response.url().includes("/.dev-cache/deps/")) modules.push({ url: response.url(), status: response.status(), cache: response.headers()["cache-control"] }); });
  page.on("websocket", socket => sockets.push(socket.url()));
  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("textarea").first().waitFor({ timeout: 20000 }).catch(async error => { console.log("real-spa: startup diagnostic", JSON.stringify({ body: await page.locator("body").innerText(), errors, failed, ownerCalls: fixture.log.slice(0, 12), modules: modules.filter(item => item.status !== 200) })); throw error; });
  assert.ok(await page.locator("#root").evaluate(element => element.childElementCount > 0));
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--p3-dev-hot").trim() === "before");
  const textarea = page.locator("textarea").first(); await textarea.fill("未送信 HMR draft");
  const birth = await page.evaluate(() => window.__p3Birth = Date.now());
  writeFileSync(cssFile, css + "\n:root { --p3-dev-hot: after; }\n");
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--p3-dev-hot").trim() === "after", null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__p3Birth), birth); assert.equal(await textarea.inputValue(), "未送信 HMR draft");
  const screens = ["/", "/settings", "/task/task-a", "/bots", "/bots/bot-a", "/bots/rooms/room-a"];
  for (const path of screens.slice(1)) {
    await page.goto(base + path, { waitUntil: "domcontentloaded" });
    if (path === "/settings") await page.getByRole("tab", { name: "エンジンタブ", exact: true }).waitFor();
    else if (path === "/task/task-a") await page.getByRole("heading", { name: "Fixture task 1", exact: true }).waitFor();
    else if (path === "/bots") await page.getByRole("heading", { name: "Bot一覧" }).waitFor();
    else if (path === "/bots/rooms/room-a") await page.locator('[aria-label="メンバー 1人"]').waitFor();
    else await page.getByText("Fixture Bot", { exact: true }).first().waitFor();
  }
  assert.ok(fixture.log.some(item => item.path === "/api/settings")); assert.ok(fixture.log.some(item => item.path === "/api/tasks"));
  assert.ok(modules.length > 2); assert.ok(modules.every(item => item.status === 200 && item.cache === "private, no-store"), JSON.stringify(modules));
  const optimized = modules.find(item => item.url.includes("react_jsx-dev-runtime.js"))?.url; assert.ok(optimized);
  assert.equal((await fetch(optimized)).status, 401);
  assert.equal((await fetch(optimized, { headers: { ...headers, origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await fetch(optimized, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
  const deps = join(scratchRoot, ".dev-cache/deps"), fsUrl = file => base + "/@fs/" + file.replaceAll("\\", "/");
  const privateFile = join(root, "private.js"); writeFileSync(privateFile, "export const privateCanary = 'fixture-private';");
  symlinkSync(privateFile, join(deps, "escaped.js"), process.platform === "win32" ? "file" : undefined);
  for (const file of [privateFile, join(deps, "escaped.js"), join(deps, "_metadata.json"), join(scratchRoot, ".dev-cache/deps_ssr/private.js"), join(deps, "missing.js")]) {
    const response = await fetch(fsUrl(file), { headers }); assert.notEqual(response.status, 200, file); assert.ok(!(await response.text()).includes("fixture-private"));
  }
  const ownerCalls = fixture.log.length;
  assert.equal((await fetch(base + "/api/settings", { headers: { ...headers, origin: "https://evil.invalid" } })).status, 403); assert.equal(fixture.log.length, ownerCalls);
  assert.equal((await fetch(base + "/api/unknown", { headers })).status, 404);
  assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.ok(sockets.length); assert.ok(sockets.every(url => new URL(url).host === new URL(base).host));
  t.diagnostic(JSON.stringify({ screens, optimizedResponses: modules.length, pageErrors: errors.length, apiRequests: fixture.log.length, draftSurvivedCssHmr: true, noOtherViteListener: true }));
});
