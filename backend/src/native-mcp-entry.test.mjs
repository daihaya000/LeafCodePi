import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acquireRuntimeOwner } from "../core/runtime-owner-lock.mjs";
import { BACKEND_HEALTH_PATH, BACKEND_MCP_SERVERS_PATH, BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";

/**
 * End-to-end check of the entry wiring for the opt-in native MCP runtime: a configuration that native
 * preparation refuses must leave the Backend serving (transport up, health honest) instead of taking
 * the whole process down or half-installing a provider.
 */
test("a refused native MCP configuration detaches the runtime but keeps the Backend serving", { timeout: 25_000 }, async (t) => {
  let child, competitor, exit, lines;
  // Register teardown before the fixture removal (after hooks run in order).
  t.after(async () => {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (competitor && competitor.exitCode === null && competitor.signalCode === null) competitor.kill();
    if (exit) await exit;
  });
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A malformed owner config makes the native preparation fail; nothing here writes the real agent dir.
  await writeFile(join(root, "mcp.json"), "{ private-fixture-token");
  const token = randomBytes(32).toString("base64url");
  const entryPath = fileURLToPath(new URL("./entry.mjs", import.meta.url));
  const env = { ...process.env, NODE_ENV: "test", PI_CODING_AGENT_DIR: root, LEAFCODE_PI_DATA_DIR: join(root, "data"),
    LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_PORT: "0",
    LEAFCODE_PI_BACKEND_RUNTIME: "1", LEAFCODE_PI_MCP_NATIVE: "1", LEAFCODE_PI_BACKEND_GENERATION: "" };
  child = spawn(process.execPath, [entryPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  exit = once(child, "exit");
  lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, "line");
  const listening = JSON.parse(line);
  assert.equal(listening.type, "backend_listening");
  const headers = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) };
  const health = await fetch(`http://127.0.0.1:${listening.port}${BACKEND_HEALTH_PATH}`, { headers });
  // Not ready (the runtime never attached) but serving, with the failed step named and no secrets.
  assert.equal(health.status, 503);
  const body = await health.json();
  assert.equal(body.ready, false);
  assert.deepEqual(body.runtimeStartupIncomplete, ["initializeRuntime"]);
  assert.equal(JSON.stringify(body).includes("private-fixture-token"), false);
  assert.equal(child.exitCode, null, "the Backend must not exit on a native MCP configuration failure");
  const ownerFile = join(root, "data", "runtime-owner.json");
  assert.equal(existsSync(ownerFile), true);
  // A second Backend pointed at the same data directory must fail before serving as another owner.
  competitor = spawn(process.execPath, [entryPath], { env, stdio: "ignore" });
  const [competitorCode] = await once(competitor, "exit");
  assert.notEqual(competitorCode, 0);
  assert.equal(existsSync(ownerFile), true, "the rejected contender must not remove the live owner's lock");
  // Owner-only endpoints refuse instead of half-working, and the process is still up.
  const servers = await fetch(`http://127.0.0.1:${listening.port}${BACKEND_MCP_SERVERS_PATH}`, { headers });
  assert.equal(servers.status, 503);
  assert.equal(child.exitCode, null);
  child.kill("SIGINT");
  await exit;
  const recoveredRelease = acquireRuntimeOwner(join(root, "data"));
  recoveredRelease();
  assert.equal(existsSync(ownerFile), false, "the owner slot is reusable after Backend exit");
});
