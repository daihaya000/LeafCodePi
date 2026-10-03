import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKEND_HEALTH_PATH, BACKEND_MCP_AUTH_SUFFIX, BACKEND_MCP_SERVERS_PATH, BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";

const WINDOWS = process.platform === "win32";
const icacls = (args) => execFileSync("icacls", args, { stdio: "pipe" });
const BUNDLE = fileURLToPath(new URL("../runtime/runtime.bundle.mjs", import.meta.url));
/** The Backend loads the built bundle, so the native auth API must already be in it (rebuild + restart). */
const bundleHasNativeAuthApi = () => { try { return readFileSync(BUNDLE, "utf8").includes("removeOAuth"); } catch { return false; } };

/**
 * Post-ACL acceptance for native auth writes in a real Backend: a strict owner-only temp agent dir
 * (the real agent dir is never touched) with one HTTP entry. Bearer/header saves must reach
 * `mcp.json`, removals must clear exactly what was saved (hand-edited headers survive), and no
 * response may carry a value.
 */
test("a real Backend persists native bearer/header auth and removes only what it saved", { timeout: 60_000, skip: !WINDOWS || !bundleHasNativeAuthApi() }, async (t) => {
  let child, exit, lines;
  t.after(async () => {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exit) await exit;
  });
  const root = mkdtempSync(join(tmpdir(), "leafcode-native-auth-"));
  t.after(() => {
    try { icacls([root, "/reset", "/T", "/C"]); } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  });
  const configPath = join(root, "mcp.json");
  const config = () => JSON.parse(readFileSync(configPath, "utf8")).mcpServers.remote;
  writeFileSync(configPath, JSON.stringify({ mcpServers: { remote: { url: "https://remote.example.invalid/mcp", headers: { "x-manual": "hand-edited" } } } }));
  const user = process.env.USERNAME;
  icacls([root, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`]);
  icacls([configPath, "/inheritance:r", "/grant:r", `${user}:F`]);

  const token = randomBytes(32).toString("base64url");
  child = spawn(process.execPath, [fileURLToPath(new URL("./entry.mjs", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "test", PI_CODING_AGENT_DIR: root, LEAFCODE_PI_DATA_DIR: join(root, "data"),
      LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_PORT: "0",
      LEAFCODE_PI_BACKEND_RUNTIME: "1", LEAFCODE_PI_MCP_NATIVE: "1", LEAFCODE_PI_BACKEND_GENERATION: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  exit = once(child, "exit");
  lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, "line");
  const listening = JSON.parse(line);
  assert.equal(listening.type, "backend_listening");
  const headers = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION), "content-type": "application/json" };
  const base = `http://127.0.0.1:${listening.port}${BACKEND_MCP_SERVERS_PATH}/remote${BACKEND_MCP_AUTH_SUFFIX}`;
  let health;
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    health = await fetch(`http://127.0.0.1:${listening.port}${BACKEND_HEALTH_PATH}`, { headers });
    if (health.status === 200) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.equal(health.status, 200, "the Backend must become ready with native MCP");

  // Bearer save: written to the config header, answered with the public snapshot only.
  const saved = await fetch(base, { method: "POST", headers, body: JSON.stringify({ type: "bearer", token: "private-fixture-token" }) });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.equal(savedBody.ok, true); assert.equal(savedBody.auth.authType, "bearer");
  assert.equal(savedBody.auth.credentialSource, "config"); assert.equal(savedBody.auth.credentialStatus, "present");
  assert.equal(JSON.stringify(savedBody).includes("private-fixture-token"), false);
  assert.equal(config().headers.Authorization, "Bearer private-fixture-token");
  assert.equal(config().headers["x-manual"], "hand-edited");

  // Header save records the name; a "headers" removal clears the saved header but keeps the manual one.
  const custom = await fetch(base, { method: "POST", headers, body: JSON.stringify({ type: "headers", headers: { "x-fixture": "private-value" } }) });
  const customBody = await custom.json();
  assert.equal(custom.status, 200, JSON.stringify(customBody));
  assert.equal(config().headers["x-fixture"], "private-value");
  const removedHeaders = await fetch(base, { method: "DELETE", headers, body: JSON.stringify({ type: "headers" }) });
  const removedHeadersBody = await removedHeaders.json();
  assert.equal(removedHeaders.status, 200, JSON.stringify(removedHeadersBody));
  assert.equal(Object.hasOwn(config().headers, "x-fixture"), false);
  assert.equal(config().headers["x-manual"], "hand-edited");
  assert.equal(config().headers.Authorization, "Bearer private-fixture-token", "a bearer save is not part of the header record");

  // Bearer removal clears the Authorization header; the manual header survives.
  const removedBearer = await fetch(base, { method: "DELETE", headers, body: JSON.stringify({ type: "bearer" }) });
  const removedBearerBody = await removedBearer.json();
  assert.equal(removedBearer.status, 200, JSON.stringify(removedBearerBody));
  assert.equal(Object.hasOwn(config().headers, "Authorization"), false);
  assert.equal(config().headers["x-manual"], "hand-edited");

  // The name record lives in the Backend data dir and never contains values.
  const record = readFileSync(join(root, "data", "mcp-header-names.json"), "utf8");
  assert.equal(record.includes("private"), false);
  // An unknown target is a 404 and a malformed body is a 400, both sanitized.
  assert.equal((await fetch(base.replace("/remote/", "/unknown/"), { method: "POST", headers, body: JSON.stringify({ type: "bearer", token: "x" }) })).status, 404);
  assert.equal((await fetch(base, { method: "POST", headers, body: JSON.stringify({ type: "bearer", token: "" }) })).status, 400);
  assert.equal(child.exitCode, null);
});
