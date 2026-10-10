import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildGateway, gatewayGraph } from "./build-gateway.mjs";
import { syncMirror } from "./web-build-mirror.mjs";
import { productionTypeConfig } from "./check-next-entry-boundary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const BASELINE = "07588a00994ab8de8765ae662c822664ab513b4b";
const COOKIE = "leafcode-pi-token=finite-browser";

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill();
  let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}
async function listen(server, port = 0) { await new Promise(resolve => server.listen(port, "127.0.0.1", resolve)); return server.address().port; }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
async function run(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", value => output = (output + value).slice(-60000));
  const timer = setTimeout(() => child.kill("SIGKILL"), 150000);
  try { const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); assert.equal(code, 0, output); }
  finally { clearTimeout(timer); }
}
function normalize(value, key = "") {
  if (typeof value === "string" && ["operationId", "revision"].includes(key) && /^[0-9a-f-]{36}$/.test(value)) return "<uuid>";
  if (key === "startedAt") return "<process-start>";
  if (Array.isArray(value)) return value.map(item => normalize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, field]) => [name,
    key === "operation" && name === "id" && typeof field === "string" && /^[0-9a-f-]{36}$/.test(field) ? "<uuid>" : normalize(field, name)]));
  return value;
}
async function observation(response) {
  const body = await response.text(); let dto;
  try {
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Not JSON");
    dto = normalize(JSON.parse(body));
    if (new URL(response.url).pathname === "/api/host-probe") { assert.match(dto.id, /^[0-9a-f-]{36}$/); dto.id = "<process-identity>"; }
    if (new URL(response.url).pathname === "/api/pi/latest-version" && dto.checkedAt !== undefined) { assert.equal(typeof dto.checkedAt, "number"); assert.ok(Math.abs(Date.now() - dto.checkedAt) < 30000); dto.checkedAt = "<request-clock>"; }
  } catch { dto = body; }
  const headers = {};
  for (const [name, value] of response.headers) if (["content-type", "content-encoding", "cache-control", "x-content-type-options", "allow", "retry-after", "vary", "etag", "content-range", "accept-ranges", "content-disposition", "cross-origin-resource-policy", "referrer-policy", "location", "refresh"].includes(name) || name.startsWith("access-control-")) headers[name] = value;
  const cookies = response.headers.getSetCookie().map(value => value.replace(/Expires=[^;]+/, "Expires=<clock>"));
  return { status: response.status, headers, cookies, dto };
}

test("production Next versus isolated gateway: complete API failure/method matrix and finite owner success transports", { timeout: 300000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-gateway-contract-")), baseline = join(root, "baseline"), candidate = join(root, "candidate"), mirror = join(root, "next"), children = [];
  const servers = [];
  t.after(async () => { for (const child of children.reverse()) await stop(child); for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } rmSync(root, { recursive: true, force: true }); });
  mkdirSync(baseline); mkdirSync(candidate);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|windir|COMSPEC|ComSpec|PATHEXT|TEMP|TMP|LOCALAPPDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/.test(name)));
  const env = { ...cleanEnv, NODE_ENV: "production", NODE_OPTIONS: "", NEXT_TELEMETRY_DISABLED: "1", HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"),
    LEAFCODE_PI_DATA_DIR: join(root, "no-web-owner-data"), LEAFCODE_PI_DEFAULT_DIR: join(root, "workspaces"), LEAFCODE_PI_PROCESS_ROLE: "next", LEAFCODE_PI_WEBUI_AUTH: "required", LEAFCODE_PI_WEBUI_TOKEN: "finite-browser",
    LEAFCODE_PI_BACKEND_TOKEN: "finite-internal-" + randomUUID(), LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_GENERATION_FILE: "", LEAFCODE_PI_PUSHOVER_TOKEN: "", LEAFCODE_PI_PUSHOVER_USER: "" };
  const archive = join(root, "baseline.tar");
  await run("git", ["archive", "--format=tar", "--output", archive, BASELINE], ROOT, env);
  await run("tar", ["-xf", archive, "-C", baseline], ROOT, env);
  // Candidate inputs are only baseline plus gateway/transport changes, never other uncommitted owner files.
  await run("tar", ["-xf", archive, "-C", candidate], ROOT, env);
  const graph = gatewayGraph(ROOT);
  for (const [file] of [...graph.sources, ...graph.declarations]) {
    if (file === "gateway/src/routes.mjs") continue;
    mkdirSync(dirname(join(candidate, file)), { recursive: true }); copyFileSync(join(ROOT, file), join(candidate, file));
  }
  for (const file of ["gateway/package.json", "gateway/package-lock.json", "shared/http-cookie.d.mts", "docs/plans/next-thin-phase0.json"]) { mkdirSync(dirname(join(candidate, file)), { recursive: true }); copyFileSync(join(ROOT, file), join(candidate, file)); }
  symlinkSync(join(ROOT, "web/node_modules"), join(candidate, "web/node_modules"), process.platform === "win32" ? "junction" : "dir");
  const built = buildGateway(candidate); assert.equal(built.routes, 166); assert.equal(built.operations, 267);
  await run(process.execPath, [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], join(candidate, "gateway"), env);
  const lock = JSON.parse(readFileSync(join(candidate, "gateway/package-lock.json"), "utf8")); assert.deepEqual(Object.keys(lock.packages).sort(), ["", "node_modules/undici"]);
  rmSync(join(candidate, "web/node_modules"), { recursive: true });
  for (const name of ["next", "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "better-sqlite3"]) assert.equal(existsSync(join(candidate, "gateway/node_modules", name)), false);
  const source = join(baseline, "web"); syncMirror({ sourceDir: source, mirrorRoot: mirror });
  // API acceptance only: these minimal test-only pages do not constitute SPA/UI acceptance.
  rmSync(join(mirror, "src/app/(app)"), { recursive: true }); rmSync(join(mirror, "src/app/login"), { recursive: true });
  writeFileSync(join(mirror, "src/app/layout.tsx"), 'export default function Layout({children}:{children:React.ReactNode}) { return <html><body>{children}</body></html>; }');
  writeFileSync(join(mirror, "src/app/page.tsx"), 'export default function Page() { return <div>HTTP fixture only</div>; }');
  const installed = join(ROOT, "web/node_modules");
  for (const name of ["next", "react", "react-dom", "undici", "typescript", "@types/node", "@types/react", "@types/react-dom"]) {
    const dest = join(mirror, "node_modules", name); mkdirSync(dirname(dest), { recursive: true }); symlinkSync(join(installed, name), dest, process.platform === "win32" ? "junction" : "dir");
  }
  const config = productionTypeConfig([...graph.manifest.map(record => record.source), "web/src/app/layout.tsx", "web/src/app/page.tsx", "web/src/proxy.ts", "web/src/instrumentation.ts"]);
  writeFileSync(join(mirror, "tsconfig.production.json"), JSON.stringify(config));
  const nextConfig = readFileSync(join(mirror, "next.config.ts"), "utf8").replace("  experimental: {", "  experimental: {\n    cpus: 2,"); writeFileSync(join(mirror, "next.config.ts"), nextConfig);
  const cli = join(installed, "next/dist/bin/next");
  await run(process.execPath, [join(installed, "typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.production.json"], mirror, env);
  await run(process.execPath, [cli, "build", "--webpack", mirror], mirror, env);
  await run(process.execPath, [join(installed, "typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.production.json"], mirror, env);
  const ownerPort = await freePort(), hostPort = await freePort();
  env.LEAFCODE_PI_BACKEND_URL = `http://127.0.0.1:${ownerPort}`; env.LEAFCODE_PI_HOST_CONTROL_URL = `http://127.0.0.1:${hostPort}`;
  const nextPort = await freePort(), gatewayPort = await freePort();
  const guard = join(root, "network-guard.mjs");
  writeFileSync(guard, `const original = globalThis.fetch; const ports = new Set(${JSON.stringify([ownerPort, hostPort, nextPort, gatewayPort].map(String))});
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin === "https://registry.npmjs.org" && /^\\/\\@earendil-works\\/(?:pi-coding-agent|pi-ai)\\/latest$/.test(decodeURIComponent(url.pathname))) return Promise.resolve(Response.json({version:"1.2.3"}));
      if (url.protocol !== "http:" || !["localhost","127.0.0.1","[::1]"].includes(url.hostname) || !ports.has(url.port)) return Promise.reject(new Error("Fixture forbids external network"));
      return original(input, init);
    };`);
  async function launch(args, cwd, port) {
    const child = spawn(process.execPath, ["--import", pathToFileURL(guard).href, ...args], { cwd, env: { ...env, LEAFCODE_PI_PORT: String(port), LEAFCODE_PI_BIND_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(child);
    let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", value => output = (output + value).slice(-60000));
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 300; i++) { assert.equal(child.exitCode, null, output); try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).status === 200) return base; } catch {} await delay(20); }
    throw new Error(output);
  }
  const nextArgs = [cli, "start", "-p", String(nextPort), "-H", "127.0.0.1", mirror], gatewayArgs = [join(candidate, "gateway/dist/gateway/src/index.mjs"), "--api-only"];
  let next = await launch(nextArgs, mirror, nextPort), gateway = await launch(gatewayArgs, join(candidate, "gateway"), gatewayPort);
  let comparisons = 0; const matrixFailures = []; let collecting = true;
  async function compare(path, method, { anonymous = false, body, headers = {}, raw = false } = {}) {
    const results = [];
    for (const base of [next, gateway]) {
      const requestHeaders = { ...(!anonymous ? { cookie: COOKIE } : {}), ...headers };
      if (body !== undefined) requestHeaders["content-type"] = "application/json";
      const payload = body !== undefined && !["GET", "HEAD"].includes(method) ? JSON.stringify(body) : undefined;
      const response = raw ? await new Promise((resolve, reject) => {
        const request = httpRequest(base, { path, method, headers: requestHeaders, signal: AbortSignal.timeout(5000) }, async incoming => {
          try {
            const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
            const headers = new Headers(); for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
            const response = new Response(method === "HEAD" || [204, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers });
            Object.defineProperty(response, "url", { value: base + path }); resolve(response);
          } catch (error) { reject(error); }
        });
        request.on("error", reject); request.end(payload);
      }) : await fetch(base + path, { method, headers: requestHeaders, redirect: "manual", ...(payload !== undefined ? { body: payload } : {}), signal: AbortSignal.timeout(5000) });
      const observed = await observation(response); assert.ok(!JSON.stringify(observed).includes(env.LEAFCODE_PI_BACKEND_TOKEN)); results.push(observed);
    }
    try { assert.deepEqual(results[1], results[0], `${method} ${path}`); } catch (error) { if (!collecting) throw error; matrixFailures.push(error.message); }
    comparisons++; return results[0];
  }
  // Compare only the frozen baseline routes. New credential routes have dedicated owner/relay tests.
  const baselineRoutes = new Set(JSON.parse(readFileSync(join(baseline, "docs/plans/next-thin-phase0.json"), "utf8")).routes.map(record => record.route));
  // Public probe ID and health start timestamps are process-local, deliberately not equal.
  for (const record of graph.manifest) {
    if (!baselineRoutes.has(record.route)) continue;
    const path = record.route.replace(/\[[^\]]+\]/g, "finite-id") + "?q=%2F&cursor=keep";
    for (const method of record.methods) {
      await compare(path, method, { body: ["GET", "HEAD", "OPTIONS"].includes(method) ? undefined : { token: "finite-browser", target: "backend", mode: "default", enabled: true } });
    }
    if (!record.methods.includes("OPTIONS")) await compare(path, "OPTIONS");
    if (record.methods.includes("GET") && !record.methods.includes("HEAD")) await compare(path, "HEAD");
    const unimplemented = ["PUT", "PATCH", "DELETE", "POST", "GET"].find(method => !record.methods.includes(method));
    if (unimplemented) await compare(path, unimplemented);
    if (!record.route.startsWith("/api/auth/webui") && !["/api/health", "/api/host-probe", "/api/peer-auth/list", "/api/peer-auth/resolve", "/api/peer-auth/usage"].includes(record.route)) await compare(path, record.methods[0], { anonymous: true });
  }
  collecting = false; assert.equal(matrixFailures.length, 0, matrixFailures.slice(0, 15).join("\n"));
  // Canonical redirects precede auth and emit a plain redirect body, not a route response.
  for (const method of ["GET", "HEAD", "POST"]) for (const anonymous of [true, false]) {
    const redirected = await compare("/api/tasks/?q=%2F&cursor=a%20b&cursor=keep", method, { anonymous });
    assert.equal(redirected.status, 308); assert.equal(redirected.headers.location, "/api/tasks?q=%2F&cursor=a%20b&cursor=keep");
    assert.equal(redirected.headers.refresh, "0;url=/api/tasks?q=%2F&cursor=a%20b&cursor=keep");
    assert.deepEqual(redirected.cookies, []); assert.equal(redirected.headers.vary, undefined);
    assert.equal(redirected.dto, method === "HEAD" ? "" : redirected.headers.location);
  }
  // Use raw HTTP: fetch/WHATWG URLs would hide backslashes and dot segments before testing.
  const separatorCases = [
    ["/api//tasks?q=a//b&cursor=%2F", "/api/tasks?q=a//b&cursor=%2F"],
    ["//api///tasks?q=%2f", "/api/tasks?q=%2f"],
    ["/api\\tasks?q=a//b", "/api/tasks?q=a//b"],
    ["/api/\\/tasks//?q=%2F&cursor=one&cursor=two", "/api/tasks/?q=%2F&cursor=one&cursor=two"],
    ["/api//tasks/../settings?q=a//b", "/api/settings?q=a//b"],
    ["/api//bots/%252F/events?q=//&cursor=%2f?keep", "/api/bots/%252F/events?q=//&cursor=%2f?keep"],
    ["/api//tasks?q='&cursor=%2F", "/api/tasks?q=%27&cursor=%2F"],
  ];
  for (const [path, location] of separatorCases) for (const method of ["GET", "HEAD", "POST"]) for (const anonymous of [true, false]) {
    const redirected = await compare(path, method, { raw: true, anonymous, ...(method === "POST" ? { body: { prompt: "must not admit" } } : {}) });
    assert.equal(redirected.status, 308); assert.equal(redirected.headers.location, location); assert.equal(redirected.headers.refresh, `0;url=${location}`);
    assert.equal(redirected.dto, method === "HEAD" ? "" : location); assert.deepEqual(redirected.cookies, []); assert.equal(redirected.headers.vary, undefined);
  }
  // Slashes in query values alone never cause path canonicalization.
  assert.equal((await compare("/api/tasks?q=a//b&cursor=%2F", "GET", { anonymous: true })).status, 401);
  // Keep the independently detected wildcard/weighted negotiation differences under assertions.
  for (const value of ["*", "deflate;q=1,gzip;q=0.5", "*;q=0.5,gzip;q=0", "identity;q=1,gzip;q=0.5", "gzip;level=1;q=0.5"]) {
    await compare("/api/health", "GET", { headers: { "accept-encoding": value } });
  }
  await compare("/api/settings/default-model", "PUT", { body: { value: "ignored" }, headers: { origin: "https://rejected.invalid", "sec-fetch-site": "cross-site" } });
  for (const base of [next, gateway]) assert.equal((await fetch(base + "/api/not-registered", { headers: { cookie: COOKIE }, redirect: "manual" })).status, 404);
  const admitted = [], fileBytes = Buffer.from("0123456789"), eventsClosed = [], hostAdmitted = [];
  let replyProtocol = "1", healthDelay = 0;
  const host = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    hostAdmitted.push({ url: request.url, method: request.method, body });
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/restart")) { response.statusCode = 202; response.end(JSON.stringify({ accepted: true })); }
    else response.end(JSON.stringify({ ok: true, enabled: true, configured: true }));
  });
  servers.push(host); await listen(host, hostPort);
  const backend = createServer(async (request, response) => {
    admitted.push({ method: request.method, url: request.url, headers: request.headers });
    assert.equal(request.headers.authorization, `Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`); assert.equal(request.headers["x-leafcode-backend-protocol"], "1");
    response.setHeader("x-leafcode-backend-protocol", replyProtocol);
    const path = request.url.split("?")[0];
    if (path === "/internal/health") {
      response.setHeader("content-type", "application/json");
      const timer = setTimeout(() => response.end(JSON.stringify({ ready: true, status: "ready", pid: process.pid, protocolVersion: 1, runtimeGeneration: "finite", startedAt: "fixture" })), healthDelay);
      response.on("close", () => clearTimeout(timer)); return;
    }
    if (path === "/internal/json-business/health" && healthDelay) {
      const timer = setTimeout(() => { response.statusCode = 503; response.end('{}'); }, healthDelay);
      response.on("close", () => clearTimeout(timer)); return;
    }
    if (path === "/internal/json-business/tasks" && request.method === "POST" && request.url.includes("finite=lost")) { response.destroy(); return; }
    if (path.startsWith("/internal/live-events/") || path.startsWith("/internal/provider-login-events/")) {
      response.setHeader("content-type", "text/event-stream"); response.flushHeaders(); response.write("id: finite-1\ndata: {\"ok\":true}\n\n");
      response.on("close", () => eventsClosed.push(path)); return;
    }
    if (path.startsWith("/internal/file-stream/")) {
      const partial = request.headers.range === "bytes=2-5", bytes = partial ? fileBytes.subarray(2, 6) : fileBytes;
      response.statusCode = partial ? 206 : 200; response.setHeader("content-type", "application/octet-stream"); response.setHeader("accept-ranges", "bytes"); response.setHeader("content-length", bytes.length); response.setHeader("cache-control", "private, no-store");
      if (partial) response.setHeader("content-range", "bytes 2-5/10"); response.end(request.method === "HEAD" ? undefined : bytes); return;
    }
    let body;
    if (path === "/internal/configuration/settings") body = { values: { "default-model": "finite-saved-value" } };
    else if (path === "/internal/json-business/tasks" && request.method === "GET") body = { status: 200, headers: { etag: '"finite"' }, body: { tasks: [], attention: [] } };
    else if (path === "/internal/json-business/tasks" && request.method === "POST") body = { status: 200, body: { task: { id: "finite-task", status: "working" }, operation: { id: request.headers["x-leafcode-business-operation"], execution: "complete" } } };
    else { response.statusCode = 503; body = { error: "Finite fixture: not implemented" }; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body));
  });
  servers.push(backend); await listen(backend, ownerPort);
  assert.equal((await compare("/api/host/restart", "POST", { body: { target: "backend" } })).status, 202);
  await compare("/api/host/browser-config", "POST", { body: { autoOpenBrowser: false } });
  const rotated = await compare("/api/host/webui-auth", "POST", { body: { token: "finite-rotated", enabled: true } });
  assert.ok(rotated.cookies.some(cookie => cookie.startsWith("leafcode-pi-token=finite-rotated;")));
  assert.equal(hostAdmitted.filter(request => request.url.startsWith("/restart")).length, 2);
  const settings = await compare("/api/settings", "GET"); assert.equal(settings.status, 200);
  const tasks = await compare("/api/tasks?kind=code", "GET"); assert.equal(tasks.status, 200);
  for (const method of ["GET", "HEAD"]) for (const headers of [{}, { range: "bytes=2-5" }]) {
    const file = await compare("/api/tasks/finite-id/media?path=finite.bin", method, { headers });
    assert.equal(file.status, headers.range ? 206 : 200); assert.equal(file.dto, method === "HEAD" ? "" : headers.range ? "2345" : "0123456789");
  }
  await compare("/api/tasks", "POST", { body: { prompt: "finite admission" }, headers: { "x-leafcode-business-authorized": "0", "x-leafcode-business-operation": "spoof" } });
  assert.equal(admitted.filter(request => request.url === "/internal/json-business/tasks" && request.method === "POST").length, 2, "one admission per frontend, never automatic resend");
  assert.ok(admitted.filter(request => request.url === "/internal/json-business/tasks" && request.method === "POST").every(request => request.headers["x-leafcode-business-authorized"] === "1" && request.headers["x-leafcode-business-operation"] !== "spoof"));
  const taskRequests = admitted.filter(request => request.url === "/internal/json-business/tasks?kind=code");
  assert.equal(taskRequests.length, 2);
  for (const name of ["x-leafcode-business-origin", "x-leafcode-business-host"]) {
    const values = taskRequests.map(request => request.headers[name].replace(/:\d+$/, ":<frontend-port>"));
    assert.equal(values[1], values[0], `owner ${name} authority`);
  }
  for (const base of [next, gateway]) {
    const controller = new AbortController();
    const response = await fetch(base + "/api/tasks/finite-id/events?cursor=keep", { headers: { cookie: COOKIE, "last-event-id": "resume-1" }, signal: controller.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /finite-1/); controller.abort(); await reader.cancel().catch(() => {});
  }
  for (let i = 0; i < 100 && eventsClosed.length < 2; i++) await delay(10); assert.equal(eventsClosed.length, 2);
  assert.ok(admitted.filter(request => request.url.startsWith("/internal/live-events/")).every(request => request.headers["last-event-id"] === "resume-1"));
  const lost = await compare("/api/tasks?finite=lost", "POST", { body: { prompt: "admitted but ACK lost" } });
  assert.equal(lost.status, 503); assert.equal(lost.dto.execution, "unknown");
  await delay(50); assert.equal(admitted.filter(request => request.method === "POST" && request.url.includes("finite=lost")).length, 2);
  const beforeSize = admitted.length;
  assert.equal((await compare("/api/tts/synthesize", "POST", { body: { text: "x".repeat(16 * 1024 + 1) } })).status, 413);
  assert.equal(admitted.length, beforeSize, "oversized input rejected before owner admission");
  replyProtocol = "2"; assert.equal((await compare("/api/tasks/finite-id/media?path=finite.bin", "GET")).status, 503); replyProtocol = "1";
  healthDelay = 1500; const deadlineStarted = Date.now(); const timeout = await compare("/api/health", "GET");
  assert.equal(timeout.dto.backendAvailable, false); assert.ok(Date.now() - deadlineStarted < 4500); healthDelay = 0;
  for (const child of children.slice(-2)) await stop(child);
  env.LEAFCODE_PI_BACKEND_GENERATION = "does-not-match-finite";
  next = await launch(nextArgs, mirror, nextPort); gateway = await launch(gatewayArgs, join(candidate, "gateway"), gatewayPort);
  const beforeGeneration = admitted.filter(request => request.url.startsWith("/internal/json-business/tasks")).length;
  assert.equal((await compare("/api/tasks", "GET")).status, 503);
  assert.equal((await compare("/api/tasks/finite-id/media?path=finite.bin", "GET")).status, 503);
  assert.equal(admitted.filter(request => request.url.startsWith("/internal/json-business/tasks")).length, beforeGeneration, "generation mismatch cannot admit an owner operation");
  assert.equal(existsSync(env.LEAFCODE_PI_DATA_DIR), false);
  t.diagnostic(`Baseline ${BASELINE}; ${comparisons} exact response comparisons; 166/267 manifest; standalone gateway clean offline install (undici only); finite successful Host/settings/tasks/command/SSE/Range/HEAD; private bearer/protocol/generation/deadline/size guard; lost admission ACK not replayed; no owner data. Representative success DTOs, not billed SDK execution.`);
});
