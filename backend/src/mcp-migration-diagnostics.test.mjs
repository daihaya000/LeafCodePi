import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKEND_MCP_MIGRATION_PATH, BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { readMcpMigrationDiagnostics } from "./mcp-migration-diagnostics.mjs";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";

const policy = { applied: false, applyAvailable: false, applyBlockedReason: "configuration-writers-not-quiesced" };
const legacy = { mcpServers: { fixture: { url: "https://example.invalid/mcp", disabled: true,
  headers: { Authorization: "private-fixture-token" } } } };
async function files(t) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledConfigPath = join(root, "bundled.json");
  await writeFile(bundledConfigPath, JSON.stringify({ mcpServers: {} }));
  await writeFile(join(root, "mcp.json"), JSON.stringify(legacy));
  return { root, options: { agentDir: root, bundledConfigPath, urlVariables: {} } };
}
async function endpoint(t, options = {}) {
  const token = randomBytes(32).toString("base64url");
  const server = createBackendServer({ token, ...options });
  t.after(() => closeBackend(server));
  const address = await listenBackend(server, 0);
  return { url: `http://127.0.0.1:${address.port}${BACKEND_MCP_MIGRATION_PATH}`,
    headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) } };
}
const request = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });

test("authenticated endpoint invokes Backend-owned dry-run without request arguments or credential disclosure", async (t) => {
  const { root, options } = await files(t);
  const source = await readFile(join(root, "mcp.json"));
  let calls = 0;
  const { url, headers } = await endpoint(t, { readMcpMigrationDiagnostics: (...args) => {
    calls++;
    assert.deepEqual(args, []);
    return readMcpMigrationDiagnostics(options);
  } });
  const response = await request(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.result.ok, true);
  assert.equal(body.result.changed, true);
  assert.equal(body.result.serverCount, 1);
  assert.match(body.result.sourceSha256, /^[a-f0-9]{64}$/);
  for (const [key, value] of Object.entries(policy)) assert.equal(body.result[key], value);
  const serialized = JSON.stringify(body);
  for (const hidden of ["private-fixture-token", root, "example.invalid", "configPath", "backupPath"]) {
    assert.equal(serialized.includes(hidden), false);
  }
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(join(root, "mcp.json")), source);
  assert.deepEqual((await readdir(root)).sort(), ["bundled.json", "mcp.json"]);
});

test("authentication and version checks run before migration diagnostics", async (t) => {
  let calls = 0;
  const { url, headers } = await endpoint(t, { readMcpMigrationDiagnostics: () => { calls++; return {}; } });
  assert.equal((await request(url)).status, 401);
  assert.equal((await request(url, { headers: { ...headers, authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await request(url, { headers: { authorization: headers.authorization } })).status, 409);
  assert.equal((await request(url, { headers: { ...headers, [BACKEND_PROTOCOL_HEADER]: "2" } })).status, 409);
  assert.equal(calls, 0);
});

test("client paths, variables and apply requests are rejected without invoking the handler", async (t) => {
  let calls = 0;
  const { url, headers } = await endpoint(t, { readMcpMigrationDiagnostics: () => { calls++; return {}; } });
  for (const query of ["configPath=other.json", "agentDir=other", "apply=true", "urlVariables=secret", "expectedSha256=anything"]) {
    assert.equal((await request(`${url}?${query}`, { headers })).status, 400);
  }
  for (const method of ["POST", "PATCH", "DELETE", "PUT", "OPTIONS", "HEAD"]) {
    const response = await request(url, { method, headers,
      ...(method === "HEAD" ? {} : { body: JSON.stringify({ apply: true, configPath: "other.json" }) }) });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }
  assert.equal(calls, 0);
});

test("missing and failing diagnostic handlers refuse safely", async (t) => {
  const missing = await endpoint(t);
  assert.equal((await request(missing.url, { headers: missing.headers })).status, 503);
  const failing = await endpoint(t, { readMcpMigrationDiagnostics: () => { throw new Error("private-fixture-token"); } });
  const response = await request(failing.url, { headers: failing.headers });
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("private-fixture-token"), false);
  assert.throws(() => createBackendServer({ token: "x".repeat(32), readMcpMigrationDiagnostics: true }), /readMcpMigrationDiagnostics/);
});

test("invalid bundled/user files remain diagnostic failures rather than writes or raw parser errors", async (t) => {
  const { root, options } = await files(t);
  await writeFile(join(root, "mcp.json"), "{ private-fixture-token");
  const badUser = await readMcpMigrationDiagnostics(options);
  assert.equal(badUser.issues[0].code, "invalid-source-json");
  await writeFile(options.bundledConfigPath, "{ private-fixture-token");
  const badBundle = await readMcpMigrationDiagnostics(options);
  assert.deepEqual(badBundle, { ok: false, issues: [{ code: "bundled-config-unreadable" }], ...policy });
  assert.equal(JSON.stringify(badUser).includes("private-fixture-token"), false);
  assert.equal(JSON.stringify(badBundle).includes("private-fixture-token"), false);
  assert.deepEqual((await readdir(root)).sort(), ["bundled.json", "mcp.json"]);
});

test("URL variables come only from Backend-owned options and never appear in diagnostics", async (t) => {
  const { root, options } = await files(t);
  await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: "${ENDPOINT}", disabled: true } } }));
  assert.equal((await readMcpMigrationDiagnostics(options)).issues[0].code, "unresolved-url-variable");
  const result = await readMcpMigrationDiagnostics({ ...options, urlVariables: { ENDPOINT: "https://private.example.invalid/mcp" } });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes("private.example.invalid"), false);
});

test("Backend entry wires diagnostics using the SDK agent directory without runtime attachment", { timeout: 15_000 }, async (t) => {
  let child, exit, lines;
  // Register process teardown before fixture removal (after hooks run in order).
  t.after(async () => {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exit) await exit;
  });
  const { root } = await files(t);
  const token = randomBytes(32).toString("base64url");
  child = spawn(process.execPath, [fileURLToPath(new URL("./entry.mjs", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "test", PI_CODING_AGENT_DIR: root, LEAFCODE_PI_DATA_DIR: join(root, "data"),
      LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_PORT: "0", LEAFCODE_PI_MCP_NATIVE: "", LEAFCODE_PI_BACKEND_RUNTIME: "",
      LEAFCODE_PI_BACKEND_GENERATION: "", N8N_MCP_URL: "https://example.invalid/mcp" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  exit = once(child, "exit");
  lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, "line");
  const listening = JSON.parse(line);
  assert.equal(listening.type, "backend_listening");
  const response = await request(`http://127.0.0.1:${listening.port}${BACKEND_MCP_MIGRATION_PATH}`, {
    headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.ok, true);
  assert.equal(body.result.serverCount, 5); // User entry plus four shipped migration defaults.
  assert.equal(body.result.applyAvailable, false);
  assert.equal(JSON.stringify(body).includes("private-fixture-token"), false);
  assert.deepEqual(JSON.parse(await readFile(join(root, "mcp.json"), "utf8")), legacy);
});
