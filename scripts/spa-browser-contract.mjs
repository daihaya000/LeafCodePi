import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { settings, startFixture } from "./spa-browser-fixture.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url))), web = join(ROOT, "web");
const require = createRequire(join(web, "package.json"));
const { chromium } = require("playwright");
const { build, preview } = await import(pathToFileURL(require.resolve("vite")).href);
const output = resolve(process.env.LEAFCODE_SPA_EVIDENCE_DIR ?? join(tmpdir(), "leafcode-spa-browser-contract"));
mkdirSync(output, { recursive: true });
const children = [], checks = [], errors = [], references = [], screenshots = [];
let fixture, spa, browser, state = { status: "running", output, checks };
const save = () => writeFileSync(join(output, "state.json"), JSON.stringify(state, null, 2));
save();
async function run(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  let log = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-100000); writeFileSync(join(output, "next-build.log"), log); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  try { const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); assert.equal(code, 0, log); } finally { clearTimeout(timer); }
}
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function checked(name, action) { await action(); checks.push(name); save(); }
async function prepareReference(origin) {
  const reference = join(output, "reference"); mkdirSync(reference, { recursive: true });
  cpSync(join(web, "src"), join(reference, "src"), { recursive: true, filter: path => !/[\\/]app[\\/]api(?:[\\/]|$)|[\\/]spa(?:[\\/]|$)|\.test\./.test(path) });
  cpSync(join(ROOT, "shared"), join(reference, "shared"), { recursive: true });
  cpSync(join(web, "public"), join(reference, "public"), { recursive: true });
  if (!existsSync(join(reference, "node_modules"))) symlinkSync(join(web, "node_modules"), join(reference, "node_modules"), "junction");
  writeFileSync(join(reference, "package.json"), JSON.stringify({ private: true, dependencies: JSON.parse(readFileSync(join(web, "package.json"))).dependencies }));
  writeFileSync(join(reference, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", jsx: "preserve", module: "esnext", moduleResolution: "bundler", skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true, allowJs: true, baseUrl: ".", paths: { "@/*": ["./src/*"], "@shared/*": ["./shared/*"] } }, exclude: ["node_modules"] }));
  cpSync(join(web, "postcss.config.mjs"), join(reference, "postcss.config.mjs"));
  writeFileSync(join(reference, "next.config.mjs"), `export default { typescript: { ignoreBuildErrors: true }, experimental: { optimizePackageImports: ['lucide-react'], cpus: 2 }, async rewrites(){ return [{source:'/api/:path*',destination:${JSON.stringify(origin)}+'/api/:path*'}]; } };`);
  const layout = join(reference, "src/app/(app)/layout.tsx");
  writeFileSync(layout, `import {MainLayoutClient} from '@/components/shell/MainLayoutClient'; export default function Layout({children}:{children:React.ReactNode}){return <MainLayoutClient initialSettings={${JSON.stringify(settings)}}>{children}</MainLayoutClient>;}`);
  const rootLayout = join(reference, "src/app/layout.tsx");
  writeFileSync(rootLayout, readFileSync(rootLayout, "utf8").replaceAll("hostname()", '"127.0.0.1"'));
  const login = join(reference, "src/app/login/page.tsx");
  writeFileSync(login, readFileSync(login, "utf8").replace('displayLeafcodePiDataPath("webui-auth.json")', '"webui-auth.json"'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HOME|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS)$/.test(name)));
  Object.assign(env, { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", LEAFCODE_PI_DATA_DIR: join(output, "data") });
  const cli = require.resolve("next/dist/bin/next"); await run([cli, "build", "--webpack", reference], reference, env);
  const port = await freePort(), child = spawn(process.execPath, [cli, "start", "-p", String(port), "-H", "127.0.0.1", reference], { cwd: reference, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  let log = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += chunk; writeFileSync(join(output, "next-runtime.log"), log); });
  for (let i = 0; i < 300; i++) { assert.equal(child.exitCode, null, log); try { if ((await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(1000) })).ok) return `http://127.0.0.1:${port}`; } catch {} await delay(50); }
  throw Error("Reference did not start");
}
async function pageFor(origin, viewport, seed = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await context.addInitScript(seed => {
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
    const Native = EventSource;
    window.__sources = [];
    window.EventSource = class extends Native {
      constructor(url, options) { super(url, options); this.record = { url: String(url), closed: false }; window.__sources.push(this.record); }
      close() { this.record.closed = true; super.close(); }
    };
    window.__documentId = Math.random().toString(36);
  }, seed);
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:" || references.includes(url.origin) || url.origin === fixture.origin) return route.continue();
    errors.push(`Forbidden browser network: ${url.origin}${url.pathname}`); return route.abort();
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(`${origin}: ${error.stack}`));
  return { page, context };
}
async function ready(page, path) {
  if (path.startsWith("/login")) await page.getByRole("heading", { name: "LeafCodePi にサインイン" }).waitFor();
  else if (path.startsWith("/settings")) await page.getByRole("tab", { name: "エンジンタブ", exact: true }).waitFor({ timeout: 20000 });
  else if (path === "/bots") await page.getByRole("heading", { name: "Bot一覧" }).waitFor();
  else if (path.startsWith("/bots/rooms/")) await page.locator('[aria-label="メンバー 1人"]').waitFor({ timeout: 20000 });
  else if (path.startsWith("/task/")) await page.getByRole("heading", { name: "Fixture task 1", exact: true }).waitFor({ timeout: 20000 });
  else { await page.locator("textarea").first().waitFor({ state: "attached", timeout: 20000 }).catch(async () => { await page.getByText("エンジン", { exact: true }).first().waitFor({ timeout: 20000 }); }); }
  await delay(450);
}
async function visual(page) {
  return page.evaluate(() => {
    const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && box.bottom > 0 && box.top < innerHeight; };
    return [...document.querySelectorAll("button,input,textarea,h1,h2,img")].filter(visible).map(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { tag: element.tagName, text: element.textContent?.trim().replace(/\s+/g, " "), label: element.getAttribute("aria-label"), placeholder: element.getAttribute("placeholder"), x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), color: style.color, background: style.backgroundColor, font: style.font, borderRadius: style.borderRadius };
    });
  });
}
try {
  fixture = await startFixture();
  await build({ configFile: join(web, "vite.config.ts"), logLevel: "silent", build: { outDir: join(output, "spa"), emptyOutDir: true } });
  spa = await preview({ configFile: join(web, "vite.config.ts"), logLevel: "silent", build: { outDir: join(output, "spa") }, preview: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.origin, changeOrigin: false } } } });
  const spaOrigin = `http://127.0.0.1:${spa.httpServer.address().port}`;
  const nextOrigin = await prepareReference(fixture.origin); references.push(spaOrigin, nextOrigin);
  browser = await chromium.launch({ headless: true, ...(process.env.LEAFCODE_TEST_CHROMIUM ? { executablePath: process.env.LEAFCODE_TEST_CHROMIUM } : {}) });
  state.origins = { spa: spaOrigin, next: nextOrigin }; state.browser = browser.version(); save();
  const paths = ["/", "/task/task-a", "/settings", "/bots", "/bots/bot-a", "/bots/rooms/room-a", "/login"];
  for (const [size, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const path of paths) await checked(`${size} direct/reload/visual ${path}`, async () => {
      const observations = [];
      for (const [kind, origin] of [["next", nextOrigin], ["spa", spaOrigin]]) {
        const { page, context } = await pageFor(origin, viewport);
        await page.goto(origin + path + "?fixture=1", { waitUntil: "domcontentloaded" }); await ready(page, path);
        assert.equal(new URL(page.url()).pathname, path);
        observations.push(await visual(page));
        const filename = `${kind}-${size}-${path.replaceAll("/", "_") || "home"}.png`; await page.screenshot({ path: join(output, filename), animations: "disabled" }); screenshots.push(filename);
        await page.reload({ waitUntil: "domcontentloaded" }); await ready(page, path); assert.equal(new URL(page.url()).pathname, path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); assert.equal(overflow, false, `${kind} ${path} overflows`);
        await context.close();
      }
      if (JSON.stringify(observations[0]) !== JSON.stringify(observations[1])) { writeFileSync(join(output, `${size}-${path.replaceAll("/", "_") || "home"}-difference.json`), JSON.stringify(observations, null, 2)); assert.deepEqual(observations[1], observations[0], `${size} ${path} visible layout/style differs`); }
    });
  }
  await checked("SPA history/query/hash and single-document navigation", async () => {
    const { page, context } = await pageFor(spaOrigin, { width: 390, height: 844 });
    await page.goto(spaOrigin + "/bots"); await ready(page, "/bots"); const documentId = await page.evaluate(() => window.__documentId);
    await page.getByRole("link", { name: /Fixture Bot/ }).first().click(); await page.waitForURL("**/bots/bot-a"); await ready(page, "/bots/bot-a");
    await page.goBack(); await page.waitForURL("**/bots"); await page.goForward(); await page.waitForURL("**/bots/bot-a");
    await page.evaluate(async () => { history.pushState(null, "", "/settings?q=one#models"); });
    await page.getByText("モデル", { exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => window.__documentId), documentId);
    await page.evaluate(() => history.replaceState(null, "", "/settings?q=two#prompts"));
    await page.waitForFunction(() => document.querySelector('#settings-tab-prompts')?.getAttribute('aria-selected') === 'true');
    assert.equal(new URL(page.url()).search, "?q=two"); assert.equal(new URL(page.url()).hash, "#prompts");
    await context.close();
  });
  await checked("SPA desktop pane/tab restore, draft and shared SSE retention", async () => {
    const stored = { version: 1, panes: [{ id: "p1", tabs: ["home", "task-a"], activeTabId: "home" }, { id: "p2", tabs: ["task-b"], activeTabId: "task-b" }], activePaneId: "p1", orientation: "horizontal" };
    const { page, context } = await pageFor(spaOrigin, { width: 1280, height: 900 }, { "webui:task-panes": JSON.stringify(stored), theme: "dark", "fixture:local": "keep" });
    await page.goto(spaOrigin + "/"); await ready(page, "/");
    await page.locator("textarea").first().fill("fixture unsent draft");
    await page.evaluate(() => { sessionStorage.setItem("fixture:session", "keep"); history.pushState(null, "", "/bots"); }); await ready(page, "/bots");
    await page.evaluate(() => history.pushState(null, "", "/")); await ready(page, "/");
    assert.equal(await page.locator("textarea").first().inputValue(), "fixture unsent draft");
    const storage = await page.evaluate(() => ({ local: localStorage.getItem("fixture:local"), session: sessionStorage.getItem("fixture:session"), theme: document.documentElement.className, sources: window.__sources.filter(item => item.url.startsWith("/api/bots/events") && !item.closed).length, panes: JSON.parse(localStorage.getItem("webui:task-panes")) }));
    assert.equal(storage.local, "keep"); assert.equal(storage.session, "keep"); assert.match(storage.theme, /dark/); assert.equal(storage.sources, 1); assert.equal(storage.panes.panes.length >= 2, true);
    await page.reload(); await ready(page, "/"); assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("webui:task-panes")).panes.length >= 2), true);
    await context.close();
  });
  await checked("SPA login fragment removal and destination", async () => {
    const { page, context } = await pageFor(spaOrigin, { width: 390, height: 844 }); const start = fixture.log.length;
    await page.goto(spaOrigin + "/login?next=%2Fsettings%3Fq%3Dcallback%23models#token=fixture-not-a-secret");
    await page.waitForURL("**/settings?q=callback#models"); await ready(page, "/settings");
    assert.equal(fixture.log.slice(start).filter(item => item.path === "/api/auth/webui").length, 1); assert.equal(new URL(page.url()).hash, "#models");
    await context.close();
  });
  await checked("SPA OAuth popup, manual callback and SSE completion", async () => {
    const { page, context } = await pageFor(spaOrigin, { width: 1280, height: 900 });
    await context.route("**/fixture-oauth", route => route.fulfill({ contentType: "text/html", body: "<h1>Fixture authorization only</h1>" }));
    await page.goto(spaOrigin + "/settings#models-providers");
    await page.getByText("Fixture OAuth", { exact: true }).first().waitFor();
    const popup = context.waitForEvent("page").catch(error => error); await page.locator("#models-providers").getByRole("button", { name: "ログイン", exact: true }).first().click();
    const authorization = await popup; if (authorization instanceof Error) throw authorization; await authorization.waitForLoadState("domcontentloaded");
    assert.equal(new URL(authorization.url()).pathname, "/fixture-oauth"); await authorization.close();
    const panel = page.getByRole("region", { name: "Fixture OAuth のログイン" });
    await panel.locator("#provider-login-input").fill(spaOrigin + "/fixture-callback?code=fixture-code&state=fixture-state");
    await panel.locator('button[type="submit"]').click();
    for (let i = 0; i < 100 && !fixture.log.some(item => item.path.endsWith("/login/callback")); i++) await delay(50);
    const callback = fixture.log.find(item => item.path.endsWith("/login/callback"));
    assert.equal(callback?.body.sessionId, "fixture-login"); assert.equal(callback?.body.input, spaOrigin + "/fixture-callback?code=fixture-code&state=fixture-state");
    await panel.getByText("ログイン完了", { exact: true }).waitFor();
    await context.close();
  });
  assert.deepEqual(errors, []);
  state = { ...state, status: "passed", checks, screenshots, requests: fixture.log, consoleErrors: errors }; save();
  console.log(JSON.stringify({ status: state.status, checks: checks.length, output }));
} catch (error) { state = { ...state, status: "failed", checks, error: error.stack, consoleErrors: errors, requests: fixture?.log }; save(); console.error(error); process.exitCode = 1; }
finally {
  await browser?.close();
  if (spa) { spa.httpServer.closeAllConnections(); await new Promise(resolve => spa.httpServer.close(resolve)); }
  await fixture?.close();
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(3000)]); }
}
