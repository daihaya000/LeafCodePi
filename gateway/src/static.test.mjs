import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticHandler, staticTargetPath } from "./static.mjs";
import { createDispatcher } from "./router.mjs";
import { createProductionGatewayServer } from "./server.mjs";

const HTML = '<!doctype html><html lang="ja"><script type="module" src="/assets/index-Abc123_-.js"></script><p>Fixture SPA 日本語 😀</p></html>';
const JS = 'document.body.dataset.fixture="snapshot";';
function build(t) {
  const root = mkdtempSync(join(tmpdir(), "gateway-static-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "assets")); writeFileSync(join(root, "index.html"), HTML);
  writeFileSync(join(root, "assets/index-Abc123_-.js"), JS);
  writeFileSync(join(root, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, "notes.txt"), "日本語 😀"); return root;
}
const req = (path, init) => new Request("http://localhost:3010" + path, init);
function auth(t, required = false) {
  const keys = ["LEAFCODE_PI_WEBUI_AUTH", "LEAFCODE_PI_WEBUI_TOKEN"], saved = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => saved[index] === undefined ? delete process.env[key] : process.env[key] = saved[index]));
  process.env[keys[0]] = required ? "required" : "disabled"; process.env[keys[1]] = "fixture-static-token";
}
async function listen(t, routes, root) {
  const server = await createProductionGatewayServer(routes, { staticRoot: root, hostname: "127.0.0.1" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
function raw(origin, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin, { path, method }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    }); request.on("error", reject); request.end();
  });
}

test("raw static targets reject traversal, double encoding, separators, NTFS aliases and malformed escapes", () => {
  for (const path of ["/../secret", "/assets/../secret", "/assets/%2e%2e/secret", "/assets/%252e%252e/secret", "/assets/.env", "/assets/a%2fb.js", "/assets/a%5Cb.js", "/assets\\secret", "//secret", "/assets/a:secret", "/assets/a%00", "/assets/a%1f", "/assets/a%7f", "/assets/a.", "/assets/a%20", "/assets/%bad", "/assets/a#fragment", "/assets/a%3fquery", "/assets/a%23hash"]) assert.equal(staticTargetPath(path), null, path);
  for (const path of ["/", "/settings/", "/assets/index-Abc123_-.js", "/日本語😀.txt"]) assert.equal(staticTargetPath(path), path);
});

test("production serves all seven screens with query/hash-independent no-store HTML and HEAD byte parity", async t => {
  const handler = await createStaticHandler(build(t));
  for (const path of ["/", "/settings", "/bots", "/bots/bot-a", "/bots/rooms/room-a", "/task/task-a", "/login"]) {
    const get = handler.handle(req(path + "?q=one#fixture")), head = handler.handle(req(path, { method: "HEAD" }));
    assert.equal(get.status, 200); assert.equal(await get.text(), HTML); assert.equal(get.headers.get("cache-control"), "no-store");
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(HTML))); assert.equal(await head.text(), ""); assert.equal(get.headers.get("content-type"), head.headers.get("content-type"));
  }
  assert.equal(handler.handle(req("/settings", { headers: { "if-none-match": "*" } })).status, 200);
});

test("Vite hashed assets are immutable; public files revalidate; validators and MIME never turn errors into HTML", async t => {
  const handler = await createStaticHandler(build(t));
  const get = handler.handle(req("/assets/index-Abc123_-.js")); assert.equal(await get.text(), JS);
  assert.equal(get.headers.get("cache-control"), "public, max-age=31536000, immutable"); assert.equal(get.headers.get("content-type"), "text/javascript; charset=utf-8"); assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  const etag = get.headers.get("etag"); assert.match(etag, /^W\/"[a-f0-9]{64}"$/);
  for (const value of [etag, etag.slice(2), `"not-current", ${etag}`, "*"]) for (const method of ["GET", "HEAD"]) {
    const cached = handler.handle(req("/assets/index-Abc123_-.js", { method, headers: { "if-none-match": value } }));
    assert.equal(cached.status, 304); assert.equal(await cached.text(), ""); assert.equal(cached.headers.get("content-length"), null);
  }
  const icon = handler.handle(req("/icon.svg")); assert.equal(icon.headers.get("content-type"), "image/svg+xml"); assert.equal(icon.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  const plain = handler.handle(req("/notes.txt")); assert.equal(await plain.text(), "日本語 😀"); assert.equal(plain.headers.get("content-type"), "text/plain; charset=utf-8");
  for (const path of ["/assets/missing.js", "/assets/index-Abc123_-.js.map", "/missing.png", "/api", "/api/unknown", "/_next/static/chunk.js", "/webui-bootstrap.json", "/unknown", "/bots/missing.png", "/src/main.tsx"]) {
    const response = handler.handle(req(path)); assert.equal(response.status, 404, path); assert.match(response.headers.get("content-type"), /application\/json/); assert.equal(response.headers.get("cache-control"), "no-store"); assert.doesNotMatch(await response.text(), /Fixture SPA/);
  }
  const post = handler.handle(req("/settings", { method: "POST" })); assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("a snapshot is unchanged after files are replaced or deleted, and invalid next builds cannot replace it", async t => {
  const root = build(t), current = await createStaticHandler(root);
  writeFileSync(join(root, "index.html"), "broken replacement"); rmSync(join(root, "assets"), { recursive: true });
  assert.equal(await current.handle(req("/settings")).text(), HTML); assert.equal(await current.handle(req("/assets/index-Abc123_-.js")).text(), JS);
  await assert.rejects(createStaticHandler(root), /nonempty index/);
  assert.equal(await current.handle(req("/task/task-a")).text(), HTML);
});

test("startup refuses missing/relative/empty/broken builds and missing emitted references without dev fallback", async t => {
  await assert.rejects(createStaticHandler(undefined), /explicit and absolute/); await assert.rejects(createStaticHandler(""), /explicit and absolute/); await assert.rejects(createStaticHandler("web/dist-spa"), /explicit and absolute/);
  const root = build(t);
  await assert.rejects(createProductionGatewayServer([], { staticRoot: join(root, "missing") }), /unavailable/);
  rmSync(join(root, "index.html")); await assert.rejects(createStaticHandler(root), /index.html/);
  writeFileSync(join(root, "index.html"), ""); await assert.rejects(createStaticHandler(root), /nonempty/);
  writeFileSync(join(root, "index.html"), "<html>Not a SPA build</html>"); await assert.rejects(createStaticHandler(root), /module entry/);
  writeFileSync(join(root, "index.html"), HTML); rmSync(join(root, "assets/index-Abc123_-.js")); await assert.rejects(createStaticHandler(root), /missing asset/);
});

test("snapshot refuses hidden/source-map/unknown/reserved files and enforces finite limits", async t => {
  for (const name of [".env", "asset.map", "asset.ts", "other.html", "webui-bootstrap.json"]) {
    const root = build(t); writeFileSync(join(root, name), "private fixture"); await assert.rejects(createStaticHandler(root), /Hidden|Unexpected/, name);
  }
  const root = build(t); mkdirSync(join(root, "api")); writeFileSync(join(root, "api/health.json"), "{}"); await assert.rejects(createStaticHandler(root), /Unexpected/);
  const bounded = build(t); await assert.rejects(createStaticHandler(bounded, { maxBytes: 1 }), /limit/); await assert.rejects(createStaticHandler(bounded, { maxFiles: 1 }), /limit/);
});

test("file/directory/root symlinks and symlink cycles cannot escape the configured build", async t => {
  const root = build(t), outside = build(t);
  for (const kind of ["file", "directory", "cycle"]) {
    const link = join(root, "escape");
    try { symlinkSync(kind === "file" ? join(outside, "notes.txt") : kind === "cycle" ? root : outside, link, kind === "file" ? "file" : process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (error.code === "EPERM" && kind === "file" && process.platform === "win32") { t.diagnostic("Windows file symlink requires privilege; directory/root junction cases still run"); continue; } throw error; }
    await assert.rejects(createStaticHandler(root), /Linked/); rmSync(link);
  }
  const alias = join(root, "root-alias"); symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createStaticHandler(alias), /linked/);
});

test("API/metadata dispatch precedes screens and assets, including failed/unknown API and API-only contract mode", async t => {
  auth(t); const handler = await createStaticHandler(build(t)); let calls = 0;
  const routes = [{ route: "/api/settings", methods: ["GET"], load: async () => ({ GET: () => { calls++; return Response.json({ error: "Owner unavailable" }, { status: 502 }); } }) }];
  const dispatch = createDispatcher(routes, { staticHandler: handler });
  const response = await dispatch(req("/api/settings")); assert.equal(response.status, 502); assert.equal(calls, 1); assert.deepEqual(await response.json(), { error: "Owner unavailable" });
  for (const path of ["/api", "/api/not-owned", "/assets/missing.js"]) { const missing = await dispatch(req(path)); assert.equal(missing.status, 404); assert.match(missing.headers.get("content-type"), /application\/json/); }
  const metadata = await dispatch(req("/webui-bootstrap.json")); assert.deepEqual(Object.keys(await metadata.json()).sort(), ["authFileDisplayPath", "hostname"]);
  assert.equal((await dispatch(req("/settings"))).headers.get("vary"), null);
  const apiOnly = await createDispatcher([])(req("/settings")); assert.equal(apiOnly.status, 404); assert.match((await apiOnly.json()).error, /Phase1/);
});

test("required auth protects every screen and API, while Login can load only build resources and resource 404s", async t => {
  auth(t, true); const { origin } = await listen(t, [], build(t));
  for (const path of ["/", "/settings", "/task/task-a", "/bots/bot-a"]) {
    const response = await fetch(origin + path + "?q=one", { redirect: "manual" }); assert.equal(response.status, 307); assert.equal(new URL(response.headers.get("location")).searchParams.get("next"), path + "?q=one"); assert.equal(response.headers.get("cache-control"), "no-store");
    const approved = await fetch(origin + path, { headers: { cookie: "leafcode-pi-token=fixture-static-token" } }); assert.equal(await approved.text(), HTML); assert.match(approved.headers.get("set-cookie"), /HttpOnly/);
  }
  assert.equal((await fetch(origin + "/login")).status, 200); assert.equal((await fetch(origin + "/assets/index-Abc123_-.js")).status, 200); assert.equal((await fetch(origin + "/icon.svg")).status, 200);
  assert.equal((await fetch(origin + "/api/not-owned")).status, 401);
  for (const path of ["/assets/missing.js", "/missing.png", "/assets/missing.map"]) { const response = await fetch(origin + path, { redirect: "manual" }); assert.equal(response.status, 404); assert.match(response.headers.get("content-type"), /application\/json/); }
  const bad = await fetch(origin + "/settings?token=fixture-static-token&q=one", { redirect: "manual" }); assert.equal(bad.status, 307); assert.equal(new URL(bad.headers.get("location")).search, "?q=one"); assert.equal(bad.headers.get("referrer-policy"), "no-referrer");
  const bearer = await fetch(origin + "/settings", { headers: { authorization: "Bearer fixture-static-token" } }); assert.equal(bearer.status, 200);
});

test("raw HTTP traversal is rejected before URL normalization and HEAD/compression/disconnect use the native adapter", async t => {
  auth(t); const root = build(t); writeFileSync(join(root, "large.txt"), "日本語😀".repeat(1000));
  const { origin } = await listen(t, [{ route: "/api/failure", methods: ["GET"], load: async () => ({ GET() { throw new Error("private fixture details"); } }) }], root);
  for (const path of ["/assets/../index.html", "/assets/%2e%2e/index.html", "/assets/%252e%252e/index.html", "/assets/%2findex.html", "/assets/..\\index.html", "/assets/index.html:private", "//settings", "/api/../settings", "/api/%2e%2e/login", "/api/tasks/../../settings"]) { const response = await raw(origin, path); assert.equal(response.status, 400, path); assert.doesNotMatch(response.body, /Fixture SPA/); }
  const head = await raw(origin, "/settings?q=head", "HEAD"); assert.equal(head.status, 200); assert.equal(head.body, ""); assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(HTML));
  const large = await fetch(origin + "/large.txt", { headers: { "accept-encoding": "gzip" } }); assert.equal(large.headers.get("content-encoding"), "gzip"); assert.equal(await large.text(), "日本語😀".repeat(1000));
  const error = await fetch(origin + "/api/failure"); assert.equal(error.status, 500); assert.deepEqual(await error.json(), { error: "Gateway request failed" });
  const redirect = await fetch(origin + "/settings/?q=one", { redirect: "manual" }); assert.equal(redirect.status, 308); assert.equal(redirect.headers.get("location"), "/settings?q=one"); assert.equal(redirect.headers.get("cache-control"), "no-store");
});
