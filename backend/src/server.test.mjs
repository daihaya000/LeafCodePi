import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BACKEND_HEALTH_PATH,
  BACKEND_PENDING_SNAPSHOTS_PATH,
  BACKEND_PROTOCOL_HEADER,
  BACKEND_PROTOCOL_VERSION,
} from "../../shared/backend-protocol.mjs";
import { createPendingSnapshotStore } from "../core/pending-snapshot-store.mjs";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";

async function fixture(t, options = {}) {
  const token = randomBytes(32).toString("base64url");
  const server = createBackendServer({ token, ...options });
  t.after(() => closeBackend(server));
  const address = await listenBackend(server, 0);
  assert.equal(address.address, "127.0.0.1");
  return {
    server,
    token,
    address,
    url: `http://127.0.0.1:${address.port}${BACKEND_HEALTH_PATH}`,
    snapshotsUrl: `http://127.0.0.1:${address.port}${BACKEND_PENDING_SNAPSHOTS_PATH}`,
    headers: {
      authorization: `Bearer ${token}`,
      [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
    },
  };
}

const request = (url, options) => fetch(url, {
  ...options, signal: AbortSignal.timeout(2_000),
});

test("requires a safe token before creating the server", () => {
  for (const token of [undefined, "", "short", "x".repeat(513), "x".repeat(32) + "\n", "x".repeat(32) + " "]) {
    assert.throws(() => createBackendServer({ token }), /Backend token/);
  }
});

test("rejects unauthorized health and does not execute readiness checks", async (t) => {
  let calls = 0;
  const { url, headers, token } = await fixture(t, { isReady: () => { calls++; return true; } });
  for (const authorization of [undefined, "Basic wrong", "Bearer wrong", `Bearer ${token.slice(1)}`]) {
    const response = await request(url, { headers: { ...headers, authorization: authorization ?? "" } });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, "BACKEND_UNAUTHORIZED");
    assert.ok(!JSON.stringify(body).includes(token));
  }
  assert.equal(calls, 0);
});

test("rejects missing and incompatible protocol versions", async (t) => {
  const { url, headers } = await fixture(t, { isReady: () => true });
  for (const version of [undefined, "0", "2", "01"]) {
    const response = await request(url, {
      headers: { authorization: headers.authorization, ...(version ? { [BACKEND_PROTOCOL_HEADER]: version } : {}) },
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "BACKEND_PROTOCOL_MISMATCH");
  }
});

test("listening alone is not SDK readiness", async (t) => {
  const { url, headers } = await fixture(t);
  const response = await request(url, { headers });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ready, false);
  assert.equal(body.status, "starting");
});

test("reports readiness with stable instance identity and no credentials", async (t) => {
  let ready = false;
  const { url, headers, token } = await fixture(t, { isReady: () => ready });
  const first = await (await request(url, { headers })).json();
  ready = true;
  const response = await request(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get(BACKEND_PROTOCOL_HEADER), String(BACKEND_PROTOCOL_VERSION));
  const body = await response.json();
  assert.equal(body.ready, true);
  assert.equal(body.protocolVersion, BACKEND_PROTOCOL_VERSION);
  assert.equal(body.pid, process.pid);
  assert.equal(body.instanceId, first.instanceId);
  assert.ok(!JSON.stringify(body).includes(token));
});

test("redacts runtime health failures", async (t) => {
  const sensitive = "private-provider-credential";
  const { url, headers } = await fixture(t, { isReady: () => { throw new Error(sensitive); } });
  const response = await request(url, { headers });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "BACKEND_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(body).includes(sensitive));
});

test("unknown routes and methods cannot bypass authentication", async (t) => {
  const { url, headers } = await fixture(t);
  const unknown = url.replace(BACKEND_HEALTH_PATH, "/internal/unknown");
  assert.equal((await request(unknown)).status, 401);
  assert.equal((await request(unknown, { headers })).status, 404);
  assert.equal((await request(url, { method: "OPTIONS" })).status, 401);
  const response = await request(url, { method: "POST", headers });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("serves the pending snapshot per task to an authenticated reader", async (t) => {
  const store = createPendingSnapshotStore({ limit: 8 });
  store.record("task-1", { eventType: "compaction_end", extra: { error: "boom" } });
  store.record("task-2", { eventType: "message_update", isDelta: true });
  const { snapshotsUrl, headers } = await fixture(t, { readPendingSnapshots: () => store.list() });
  const response = await request(snapshotsUrl, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    snapshots: [
      { taskId: "task-1", eventType: "compaction_end", extra: { error: "boom" }, isDelta: false },
      // `extra` is absent, not null: JSON drops the undefined field.
      { taskId: "task-2", eventType: "message_update", isDelta: true },
    ],
  });
});

test("an empty or failing pending snapshot read stays contained", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t);
  assert.deepEqual(await (await request(snapshotsUrl, { headers })).json(), { snapshots: [] });
  const sensitive = "private-task-path";
  const failing = await fixture(t, { readPendingSnapshots: () => { throw new Error(sensitive); } });
  const response = await request(failing.snapshotsUrl, { headers: failing.headers });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "BACKEND_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(body).includes(sensitive));
});

test("the pending snapshot route needs authentication, the protocol header and GET", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t);
  assert.equal((await request(snapshotsUrl)).status, 401);
  assert.equal((await request(snapshotsUrl, { headers: { authorization: headers.authorization } })).status, 409);
  const response = await request(snapshotsUrl, { method: "POST", headers });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal((await request(snapshotsUrl.replace("pending-snapshots", "unknown"), { headers })).status, 404);
});

test("a non-function pending snapshot reader is rejected at creation", () => {
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), readPendingSnapshots: "nope" }),
    /readPendingSnapshots/,
  );
});

test("rejects invalid ports and surfaces occupied port errors", async (t) => {
  const { server, address } = await fixture(t);
  for (const port of [-1, 65536, 1.5, "3010", NaN]) {
    await assert.rejects(listenBackend(server, port), /Invalid backend port/);
  }
  const other = createBackendServer({ token: randomBytes(32).toString("base64url") });
  await assert.rejects(listenBackend(other, address.port), { code: "EADDRINUSE" });
  await closeBackend(other);
});

test("close releases the socket and is idempotent", async (t) => {
  const { server, url, headers } = await fixture(t);
  await closeBackend(server);
  assert.equal(server.listening, false);
  await closeBackend(server);
  await assert.rejects(request(url, { headers }));
});

test("CLI starts as a separate process without pretending SDK is ready", { timeout: 5_000 }, async (t) => {
  const token = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./entry.mjs", import.meta.url))], {
    env: { ...process.env, LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  });
  const [line] = await once(lines, "line");
  const listening = JSON.parse(line);
  assert.equal(listening.type, "backend_listening");
  assert.equal(listening.address, "127.0.0.1");
  assert.notEqual(child.pid, process.pid);
  assert.ok(!line.includes(token));
  const response = await request(`http://127.0.0.1:${listening.port}${BACKEND_HEALTH_PATH}`, {
    headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).pid, child.pid);
});

test("CLI refuses missing credentials and malformed ports", { timeout: 5_000 }, async () => {
  for (const env of [
    { LEAFCODE_PI_BACKEND_TOKEN: "", LEAFCODE_PI_BACKEND_PORT: "0" },
    { LEAFCODE_PI_BACKEND_TOKEN: randomBytes(32).toString("base64url"), LEAFCODE_PI_BACKEND_PORT: "wrong" },
  ]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./entry.mjs", import.meta.url))], {
      env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.match(output, /Backend startup failed/);
    if (env.LEAFCODE_PI_BACKEND_TOKEN) assert.ok(!output.includes(env.LEAFCODE_PI_BACKEND_TOKEN));
  }
});
