import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKEND_MCP_SERVERS_PATH, BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";

async function endpoint(t, options = {}) {
  const token = randomBytes(32).toString("base64url");
  const server = createBackendServer({ token, isReady: () => true, ...options });
  t.after(() => closeBackend(server));
  const address = await listenBackend(server, 0);
  return { url: `http://127.0.0.1:${address.port}${BACKEND_MCP_SERVERS_PATH}/fixture`,
    headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) } };
}
const request = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
const patch = (url, headers, body = { enabled: false }) => request(url, { method: "PATCH", headers, body: JSON.stringify(body) });

test("MCP ON/OFF reaches only the authenticated owner handler with name and boolean", async (t) => {
  const calls = [];
  const answer = { ok: true, name: "fixture", enabled: false, servers: [] };
  const { url, headers } = await endpoint(t, { setMcpServerEnabledAction: (...args) => { calls.push(args); return answer; } });
  assert.equal((await patch(url, {})).status, 401);
  assert.equal((await patch(url, { authorization: headers.authorization })).status, 409);
  assert.equal(calls.length, 0);
  const response = await patch(url, headers);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), answer);
  assert.deepEqual(calls, [["fixture", false]]);
});

test("MCP endpoint rejects path/body privilege escalation and wrong methods", async (t) => {
  let calls = 0;
  const { url, headers } = await endpoint(t, { setMcpServerEnabledAction: () => { calls++; } });
  for (const body of [null, [], {}, { enabled: "false" }, { enabled: true, configPath: "other" }, { enabled: false, url: "https://other.invalid" }]) {
    assert.equal((await patch(url, headers, body)).status, 400);
  }
  for (const name of ["%ZZ", "", "a%2Fb", "a%5Cb", "bad..name", "fixture?agentDir=other"]) {
    assert.equal((await patch(url.replace(/fixture$/, name), headers)).status, 400);
  }
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await request(url, { method, headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "PATCH");
  }
  assert.equal(calls, 0);
});

test("a detached, unready or failed readiness check never invokes the write handler", async (t) => {
  let calls = 0;
  for (const options of [{}, { setMcpServerEnabledAction: () => { calls++; }, isReady: () => false },
    { setMcpServerEnabledAction: () => { calls++; }, isReady: () => { throw new Error("private-fixture-token"); } }]) {
    const { url, headers } = await endpoint(t, options);
    assert.equal((await patch(url, headers)).status, 503);
  }
  assert.equal(calls, 0);
  assert.throws(() => createBackendServer({ token: "x".repeat(32), setMcpServerEnabledAction: true }), /setMcpServerEnabledAction/);
});

test("MCP owner refusal statuses survive without exception details", async (t) => {
  for (const status of [400, 404, 409, 503, 500]) {
    const { url, headers } = await endpoint(t, { setMcpServerEnabledAction: () => {
      throw Object.assign(new Error("private-fixture-token"), { status });
    } });
    const response = await patch(url, headers);
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes("private-fixture-token"), false);
    if (status === 409) assert.equal(body.code, "BACKEND_BAD_REQUEST");
  }
});

test("auth status GET is authenticated, read-only and refuses arbitrary names and parameters", async (t) => {
  const calls = [];
  const { url: itemUrl, headers } = await endpoint(t, { readMcpAuthStatus: (name) => {
    calls.push(name); return { name, configPath: "owner-private-path", token: "private-fixture-secret", credentialMessage: "private-fixture-secret",
      authType: "none", credentialConfigured: false,
      credentialSource: "none", credentialStatus: "missing" };
  } });
  const url = `${itemUrl}/auth`;
  assert.equal((await request(url)).status, 401);
  assert.equal((await request(url, { headers: { authorization: headers.authorization } })).status, 409);
  for (const method of ["PATCH"]) {
    const response = await request(url, { method, headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST, DELETE");
  }
  for (const suffix of ["?configPath=other", "?token=secret"]) assert.equal((await request(url + suffix, { headers })).status, 400);
  assert.equal((await request(url.replace("fixture/auth", "a%2Fb/auth"), { headers })).status, 400);
  assert.equal(calls.length, 0);
  const success = await request(url, { headers });
  assert.equal(success.status, 200);
  const snapshot = await success.json();
  assert.equal(snapshot.configPath, "");
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  assert.deepEqual(calls, ["fixture"]);
  const missing = await endpoint(t);
  assert.equal((await request(`${missing.url}/auth`, { headers: missing.headers })).status, 503);
  const failing = await endpoint(t, { readMcpAuthStatus: () => { throw new Error("private-fixture-secret"); } });
  const failed = await request(`${failing.url}/auth`, { headers: failing.headers });
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes("private-fixture-secret"), false);
  assert.throws(() => createBackendServer({ token: "x".repeat(32), readMcpAuthStatus: true }), /readMcpAuthStatus/);
});

test("bearer save POST is authenticated, whitelisted and never exposes credential or reload errors", async (t) => {
  const calls = [];
  const { url: itemUrl, headers } = await endpoint(t, { saveMcpBearerAuthAction: (name, input) => {
    calls.push([name, input]); return { ok: true, token: input.token,
      auth: { name, configPath: "owner-private-path", authType: "bearer", credentialConfigured: true,
        credentialSource: "secure-store", credentialStatus: "present", credentialMessage: input.token },
      reload: { reloaded: 1, deferred: 0, failed: 1, errors: [input.token] } };
  } });
  const url = `${itemUrl}/auth`;
  const input = { type: "bearer", token: "private-fixture-token" };
  const post = (body, auth = headers, target = url) => request(target, { method: "POST", headers: auth, body: JSON.stringify(body) });
  assert.equal((await post(input, {})).status, 401);
  assert.equal((await post(input, { authorization: headers.authorization })).status, 409);
  for (const body of [null, [], {}, { token: "" }, { ...input, configPath: "other" }, { ...input, type: "oauth" },
    { ...input, headers: {} }, { token: "x\ny" }, { token: "x".repeat(8193) }]) assert.equal((await post(body)).status, 400);
  for (const name of ["%ZZ", "a%2Fb", "a%5Cb", "bad..name"]) {
    assert.equal((await post(input, headers, url.replace("fixture/auth", `${name}/auth`))).status, 400);
  }
  assert.equal((await post(input, headers, `${url}?agentDir=other`)).status, 400);
  assert.equal((await request(url, { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await post({ token: "x".repeat(70_000) })).status, 400);
  assert.equal(calls.length, 0);
  const success = await post({ ...input, token: ` ${input.token} ` });
  assert.equal(success.status, 200);
  assert.equal((await success.text()).includes("private"), false);
  assert.deepEqual(calls, [["fixture", input]]);
  for (const options of [{}, { saveMcpBearerAuthAction: () => { calls.push("unexpected"); }, isReady: () => false },
    { saveMcpBearerAuthAction: () => { calls.push("unexpected"); }, isReady: () => { throw new Error(input.token); } }]) {
    const unavailable = await endpoint(t, options);
    assert.equal((await post(input, unavailable.headers, `${unavailable.url}/auth`)).status, 503);
  }
  assert.equal(calls.length, 1);
  for (const status of [400, 404, 409, 503, 500]) {
    const failed = await endpoint(t, { saveMcpBearerAuthAction: () => { throw Object.assign(new Error(input.token), { status }); } });
    const response = await post(input, failed.headers, `${failed.url}/auth`);
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes(input.token), false);
  }
  const malformed = await endpoint(t, { saveMcpBearerAuthAction: () => ({ token: input.token }) });
  assert.equal((await post(input, malformed.headers, `${malformed.url}/auth`)).status, 500);
  assert.throws(() => createBackendServer({ token: "x".repeat(32), saveMcpBearerAuthAction: true }), /saveMcpBearerAuthAction/);
});

test("header save POST is owner-only, validates private headers and sanitizes every response", async (t) => {
  const calls = [];
  const { url: itemUrl, headers } = await endpoint(t, { saveMcpHeadersAuthAction: (name, input) => {
    calls.push([name, input]); return { ok: true, headers: input.headers,
      auth: { name, configPath: "owner-private-path", authType: "headers", credentialConfigured: true,
        credentialSource: "secure-store", credentialStatus: "present", credentialMessage: "private-fixture-secret" },
      reload: { reloaded: 0, deferred: 0, failed: 1, errors: ["private-fixture-secret"] } };
  }, saveMcpBearerAuthAction: () => { throw new Error("Wrong auth handler"); } });
  const url = `${itemUrl}/auth`;
  const input = { type: "headers", headers: { "X-Key": "private-fixture-secret" } };
  const post = (body, auth = headers, target = url) => request(target, { method: "POST", headers: auth, body: JSON.stringify(body) });
  assert.equal((await post(input, {})).status, 401);
  assert.equal((await post(input, { authorization: headers.authorization })).status, 409);
  for (const body of [{ ...input, configPath: "other" }, { ...input, token: "secret" }, { ...input, headers: {} },
    { ...input, headers: { "Bad Header": "secret" } }, { ...input, headers: { "X-Key": "a\nb" } },
    { ...input, headers: { "X-Key": "x".repeat(8193) } }]) assert.equal((await post(body)).status, 400);
  assert.equal((await post(input, headers, `${url}?agentDir=other`)).status, 400);
  assert.equal((await post(input, headers, url.replace("fixture/auth", "a%2Fb/auth"))).status, 400);
  await assert.rejects(post({ ...input, headers: { "X-Key": "x".repeat(2_100_000) } }));
  assert.equal(calls.length, 0);
  const success = await post(input);
  assert.equal(success.status, 200);
  assert.equal((await success.text()).includes("private"), false);
  assert.deepEqual(calls, [["fixture", input]]);
  for (const options of [{}, { saveMcpHeadersAuthAction: () => { calls.push("unexpected"); }, isReady: () => false }]) {
    const unavailable = await endpoint(t, options);
    assert.equal((await post(input, unavailable.headers, `${unavailable.url}/auth`)).status, 503);
  }
  const bearerOnly = await endpoint(t, { saveMcpBearerAuthAction: () => { calls.push("unexpected"); } });
  assert.equal((await post(input, bearerOnly.headers, `${bearerOnly.url}/auth`)).status, 503);
  assert.equal(calls.length, 1);
  for (const status of [400, 404, 409, 503, 500]) {
    const failed = await endpoint(t, { saveMcpHeadersAuthAction: () => { throw Object.assign(new Error("private-fixture-secret"), { status }); } });
    const response = await post(input, failed.headers, `${failed.url}/auth`);
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes("private"), false);
  }
  assert.throws(() => createBackendServer({ token: "x".repeat(32), saveMcpHeadersAuthAction: true }), /saveMcpHeadersAuthAction/);
});

test("bearer/header DELETE reaches only the owner with explicit or owner-resolved defaults", async (t) => {
  const calls = [];
  const { url: itemUrl, headers } = await endpoint(t, { removeMcpAuthAction: (name, input) => {
    calls.push([name, input]); return { ok: true, token: "private-fixture-secret",
      auth: { name, configPath: "owner-private-path", authType: input.type ?? "headers", credentialConfigured: false,
        credentialSource: "none", credentialStatus: "missing", credentialMessage: "private-fixture-secret" },
      reload: { reloaded: 0, deferred: 0, failed: 1, errors: ["private-fixture-secret"] } };
  } });
  const url = `${itemUrl}/auth`;
  const del = (body, auth = headers, target = url) => request(target, { method: "DELETE", headers: auth,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await del({ type: "headers" }, {})).status, 401);
  assert.equal((await del({}, { authorization: headers.authorization })).status, 409);
  for (const body of [null, [], { type: "headers", action: "bearer" }, { type: "oauth" }, { type: "bearer", token: "private-fixture-secret" },
    { type: "headers", headers: { Authorization: "private-fixture-secret" } }, { type: "headers", configPath: "other" }]) {
    assert.equal((await del(body)).status, 400);
  }
  assert.equal((await request(url, { method: "DELETE", headers, body: "{" })).status, 400);
  assert.equal((await del({}, headers, `${url}?agentDir=other`)).status, 400);
  assert.equal((await del({}, headers, url.replace("fixture/auth", "a%2Fb/auth"))).status, 400);
  assert.equal(calls.length, 0);
  for (const body of [{ action: "bearer" }, { type: "headers" }, { action: "headers" }, {}, undefined]) {
    const response = await del(body);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes("private"), false);
  }
  assert.deepEqual(calls, [["fixture", { type: "bearer" }], ["fixture", { type: "headers" }],
    ["fixture", { type: "headers" }], ["fixture", {}], ["fixture", {}]]);
  for (const options of [{}, { removeMcpAuthAction: () => { calls.push("unexpected"); }, isReady: () => false },
    { removeMcpAuthAction: () => { calls.push("unexpected"); }, isReady: () => { throw new Error("private-fixture-secret"); } }]) {
    const unavailable = await endpoint(t, options);
    assert.equal((await del({}, unavailable.headers, `${unavailable.url}/auth`)).status, 503);
  }
  assert.equal(calls.length, 5);
  for (const status of [400, 404, 409, 503, 500]) {
    const failed = await endpoint(t, { removeMcpAuthAction: () => { throw Object.assign(new Error("private-fixture-secret"), { status }); } });
    const response = await del({ type: "headers" }, failed.headers, `${failed.url}/auth`);
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes("private"), false);
  }
  const malformed = await endpoint(t, { removeMcpAuthAction: () => ({ token: "private-fixture-secret" }) });
  assert.equal((await del({}, malformed.headers, `${malformed.url}/auth`)).status, 500);
  assert.throws(() => createBackendServer({ token: "x".repeat(32), removeMcpAuthAction: true }), /removeMcpAuthAction/);
});

test("preset creation is authenticated, owner-ready and limited to known request shapes", async (t) => {
  const calls = [];
  const { url: itemUrl, headers } = await endpoint(t, { createMcpPresetAction: (input) => {
    calls.push(input); return { ok: true, name: input.preset, servers: [], reload: { reloaded: 0, deferred: 0, failed: 0, errors: [] } };
  } });
  const url = itemUrl.replace(/\/fixture$/, "");
  const post = (body, auth = headers, target = url) => request(target, { method: "POST", headers: auth, body: JSON.stringify(body) });
  assert.equal((await post({ preset: "notion" }, {})).status, 401);
  assert.equal((await post({ preset: "notion" }, { authorization: headers.authorization })).status, 409);
  for (const body of [null, [], { preset: "other" }, { preset: "notion", configPath: "other" },
    { preset: "n8n", url: "example.invalid", command: "run" }, { preset: "google-workspace", clientId: "x" }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post({ preset: "notion" }, headers, `${url}?apply=true`)).status, 400);
  assert.equal(calls.length, 0);
  for (const body of [{ preset: "n8n", url: "example.invalid" }, { preset: "slack", clientId: "x" },
    { preset: "google-workspace", clientId: "x", clientSecret: "private-fixture-secret" }, { preset: "notion" }]) {
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes("private-fixture-secret"), false);
    assert.deepEqual(calls.at(-1), body);
  }
  const missing = await endpoint(t);
  assert.equal((await request(missing.url.replace(/\/fixture$/, ""), { method: "POST", headers: missing.headers,
    body: JSON.stringify({ preset: "notion" }) })).status, 503);
  assert.equal((await request(url, { headers })).status, 405);
  assert.throws(() => createBackendServer({ token: "x".repeat(32), createMcpPresetAction: true }), /createMcpPresetAction/);
});

test("Backend entry persists ON/OFF through the rebuilt runtime and returns only redacted DTOs", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-owner-write-"));
  const configPath = join(root, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: {
    command: "fixture-server", disabled: true, args: ["--mcp"], env: { KEY: "private-fixture-token" },
  } } }));
  const token = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./entry.mjs", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "test", PI_CODING_AGENT_DIR: root, LEAFCODE_PI_DATA_DIR: join(root, "data"),
      LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_PORT: "0", LEAFCODE_PI_BACKEND_RUNTIME: "attach",
      LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    await rm(root, { recursive: true, force: true });
  });
  const [line] = await once(lines, "line");
  const listening = JSON.parse(line);
  const base = `http://127.0.0.1:${listening.port}`;
  const headers = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) };
  const deadline = Date.now() + 8_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = (await request(`${base}/internal/health`, { headers })).status === 200;
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true);
  const response = await patch(`${base}${BACKEND_MCP_SERVERS_PATH}/fixture`, headers, { enabled: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, "fixture");
  assert.equal(body.enabled, true);
  assert.equal(body.servers.find((server) => server.id === "fixture").enabled, true);
  assert.equal(JSON.stringify(body).includes("private-fixture-token"), false);
  assert.equal(JSON.stringify(body).includes(root), false);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(Object.hasOwn(config.mcpServers.fixture, "disabled"), false);
  assert.deepEqual(config.mcpServers.fixture.args, ["--mcp"]);
  assert.equal(config.mcpServers.fixture.env.KEY, "private-fixture-token");
  const missing = await patch(`${base}${BACKEND_MCP_SERVERS_PATH}/missing-fixture`, headers);
  assert.equal(missing.status, 404);
  for (const input of [{ preset: "n8n", url: "example.app.n8n.cloud" }, { preset: "slack", clientId: "fixture-client" },
    { preset: "google-workspace", clientId: "fixture-client", clientSecret: "private-fixture-google-secret" }, { preset: "notion" }]) {
    const added = await request(`${base}${BACKEND_MCP_SERVERS_PATH}`, { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(added.status, 200);
    const answer = await added.json();
    assert.equal(answer.name, input.preset);
    assert.deepEqual(answer.reload, { reloaded: 0, deferred: 0, failed: 0, errors: [] });
    assert.equal(JSON.stringify(answer).includes("private-fixture-google-secret"), false);
    assert.equal(JSON.stringify(answer).includes(root), false);
  }
  const written = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(written.mcpServers.n8n.url, "https://example.app.n8n.cloud/mcp-server/http");
  assert.equal(written.mcpServers.slack.oauth.clientId, "fixture-client");
  assert.equal(written.mcpServers["gws-calendar"].oauth.clientSecret, "private-fixture-google-secret");
  assert.equal(written.mcpServers.fixture.env.KEY, "private-fixture-token");
  const duplicate = await request(`${base}${BACKEND_MCP_SERVERS_PATH}`, { method: "POST", headers, body: JSON.stringify({ preset: "notion" }) });
  assert.equal(duplicate.status, 409);
  const beforeStatus = await readFile(configPath);
  const authResponse = await request(`${base}${BACKEND_MCP_SERVERS_PATH}/n8n/auth`, { headers });
  assert.equal(authResponse.status, 200);
  const auth = await authResponse.json();
  assert.equal(auth.name, "n8n");
  assert.equal(auth.authType, "oauth");
  assert.equal(auth.credentialStatus, "unavailable"); // No live bridge in this isolated runtime.
  assert.equal(auth.configPath, "");
  assert.equal(JSON.stringify(auth).includes(root), false);
  assert.deepEqual(await readFile(configPath), beforeStatus);
  const detachedSave = await request(`${base}${BACKEND_MCP_SERVERS_PATH}/n8n/auth`, {
    method: "POST", headers, body: JSON.stringify({ type: "bearer", token: "private-fixture-bearer-token" }),
  });
  assert.equal(detachedSave.status, 503); // No live credential-store bridge: fail closed, no selector write.
  assert.equal((await detachedSave.text()).includes("private-fixture-bearer-token"), false);
  const detachedHeaders = await request(`${base}${BACKEND_MCP_SERVERS_PATH}/n8n/auth`, {
    method: "POST", headers, body: JSON.stringify({ type: "headers", headers: { "X-Key": "private-fixture-header-secret" } }),
  });
  assert.equal(detachedHeaders.status, 503);
  assert.equal((await detachedHeaders.text()).includes("private-fixture-header-secret"), false);
  const defaultDelete = await request(`${base}${BACKEND_MCP_SERVERS_PATH}/n8n/auth`, { method: "DELETE", headers });
  assert.equal(defaultDelete.status, 400); // OAuth default must not silently delete bearer credentials.
  const explicitDelete = await request(`${base}${BACKEND_MCP_SERVERS_PATH}/n8n/auth`, {
    method: "DELETE", headers, body: JSON.stringify({ type: "bearer" }),
  });
  assert.equal(explicitDelete.status, 503); // No live credential store in this isolated Backend.
  const explicitHeaderDelete = await request(`${base}${BACKEND_MCP_SERVERS_PATH}/n8n/auth`, {
    method: "DELETE", headers, body: JSON.stringify({ type: "headers" }),
  });
  assert.equal(explicitHeaderDelete.status, 503);
  assert.equal((await explicitHeaderDelete.text()).includes(root), false);
  assert.deepEqual(await readFile(configPath), beforeStatus);
  // Fixture-only owner configuration: an omitted method must now resolve headers, not bearer/OAuth.
  const headerConfig = JSON.parse(beforeStatus.toString("utf8"));
  headerConfig.mcpServers.n8n.headersStore = true;
  headerConfig.mcpServers.n8n.auth = false;
  await writeFile(configPath, JSON.stringify(headerConfig));
  const beforeHeaderDelete = await readFile(configPath);
  const defaultHeaderDelete = await request(`${base}${BACKEND_MCP_SERVERS_PATH}/n8n/auth`, { method: "DELETE", headers });
  assert.equal(defaultHeaderDelete.status, 503);
  assert.deepEqual(await readFile(configPath), beforeHeaderDelete);
});
