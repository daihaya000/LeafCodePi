import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKEND_HEALTH_PATH, BACKEND_MCP_SERVERS_PATH, BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";

const WINDOWS = process.platform === "win32";
const icacls = (args) => execFileSync("icacls", args, { stdio: "pipe" });

/**
 * Post-ACL acceptance in a real Backend process: a temp agent directory with the same strict
 * owner-only ACL the runtime demands (the real agent dir is never touched) holding one enabled stdio
 * server. The Backend must become ready with the native runtime attached, and an ON/OFF write through
 * the settings endpoint must persist and republish without breaking the process.
 */
test("a real Backend becomes ready with native MCP and persists an ON/OFF toggle", { timeout: 60_000, skip: !WINDOWS }, async (t) => {
  let child, exit, lines;
  t.after(async () => {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exit) await exit;
  });
  const root = mkdtempSync(join(tmpdir(), "leafcode-native-toggle-"));
  t.after(() => {
    try { icacls([root, "/reset", "/T", "/C"]); } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  });
  const configPath = join(root, "mcp.json");
  cpSync(join(fileURLToPath(new URL("../core/mcp-defaults.json", import.meta.url))), configPath);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.mcpServers = { fixture: { command: process.execPath, args: ["--version"] } };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(configPath, JSON.stringify(config)));
  // Strict owner-only ACL: the directory needs container-inheriting full control, the file an explicit
  // full control without inherit-only flags (that is what the storage policy accepts).
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
  const base = `http://127.0.0.1:${listening.port}`;

  // The native runtime attests the strict ACL, loads the config and installs the provider.
  let health;
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    health = await fetch(`${base}${BACKEND_HEALTH_PATH}`, { headers });
    if (health.status === 200) break;
    const body = await health.clone().json();
    assert.equal(body.runtimeStartupIncomplete.includes("initializeRuntime"), false, JSON.stringify(body.runtimeStartupIncomplete));
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.equal(health.status, 200, "the Backend must become ready with a strict-ACL agent dir");
  const ready = await health.json();
  assert.equal(ready.ready, true); assert.deepEqual(ready.runtimeStartupIncomplete, []);

  // ON/OFF through the owner endpoint: persisted in the file, acknowledged, and the process stays up.
  const off = await fetch(`${base}${BACKEND_MCP_SERVERS_PATH}/fixture`, { method: "PATCH", headers, body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200, await off.text());
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.fixture.disabled, true);
  const on = await fetch(`${base}${BACKEND_MCP_SERVERS_PATH}/fixture`, { method: "PATCH", headers, body: JSON.stringify({ enabled: true }) });
  assert.equal(on.status, 200, await on.text());
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.fixture, "disabled"), false);
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(`${base}${BACKEND_HEALTH_PATH}`, { headers })).status, 200);
});
