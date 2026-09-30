import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("serves the Backend's own task view to an authenticated reader", async (t) => {
  const tasks = [{ id: "task-1", title: "first" }, { id: "task-2", title: "second" }];
  const { url, snapshotsUrl, headers } = await fixture(t, {
    readTasks: () => tasks,
    readTask: (id) => tasks.find((task) => task.id === id) ?? null,
  });
  const tasksUrl = snapshotsUrl.replace("pending-snapshots", "tasks");
  const list = await request(tasksUrl, { headers });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { tasks });
  const one = await request(`${tasksUrl}/task-2`, { headers });
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), { task: { id: "task-2", title: "second" } });
  const missing = await request(`${tasksUrl}/nope`, { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "BACKEND_NOT_FOUND");
  assert.ok(url.includes("/internal/health"), "the health route still exists");
});

test("the task view needs authentication, the protocol header and GET", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t, { readTasks: () => [] });
  const tasksUrl = snapshotsUrl.replace("pending-snapshots", "tasks");
  assert.equal((await request(tasksUrl)).status, 401);
  assert.equal((await request(tasksUrl, { headers: { authorization: headers.authorization } })).status, 409);
  const response = await request(tasksUrl, { method: "POST", headers });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("a failing task read stays contained and an empty store is not an error", async (t) => {
  const sensitive = "C:/private/store.json";
  const failing = await fixture(t, {
    readTasks: () => { throw new Error(`cannot read ${sensitive}`); },
    readTask: () => { throw new Error(`cannot read ${sensitive}`); },
  });
  const failingUrl = failing.snapshotsUrl.replace("pending-snapshots", "tasks");
  const list = await request(failingUrl, { headers: failing.headers });
  assert.equal(list.status, 500);
  const body = await list.json();
  assert.equal(body.code, "BACKEND_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(body).includes(sensitive));
  const one = await request(`${failingUrl}/task-1`, { headers: failing.headers });
  assert.equal(one.status, 500);
  assert.ok(!JSON.stringify(await one.json()).includes(sensitive));

  const empty = await fixture(t);
  const emptyUrl = empty.snapshotsUrl.replace("pending-snapshots", "tasks");
  assert.deepEqual(await (await request(emptyUrl, { headers: empty.headers })).json(), { tasks: [] });
  assert.equal((await request(`${emptyUrl}/task-1`, { headers: empty.headers })).status, 404);
});

test("a non-function task reader is rejected at creation", () => {
  for (const options of [{ readTasks: "nope" }, { readTask: 42 }]) {
    assert.throws(
      () => createBackendServer({ token: randomBytes(32).toString("base64url"), ...options }),
      /must be a function/,
    );
  }
});

test("task detail reports a detached runtime instead of a missing task", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t);
  const detailUrl = snapshotsUrl.replace("pending-snapshots", "tasks") + "/task-1/detail";
  const response = await request(detailUrl, { headers });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "BACKEND_RUNTIME_UNAVAILABLE");
  assert.ok(!JSON.stringify(body).includes("task-1"), "the task id is not echoed back");
});

test("an attached runtime serves the task detail through the bundle reader", async (t) => {
  const detail = { id: "task-1", title: "detail", messages: [{ id: "m1" }] };
  const { snapshotsUrl, headers } = await fixture(t, {
    readTaskDetail: async (id) => (id === "task-1" ? detail : null),
  });
  const base = snapshotsUrl.replace("pending-snapshots", "tasks");
  const found = await request(`${base}/task-1/detail`, { headers });
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { detail });
  assert.equal((await request(`${base}/nope/detail`, { headers })).status, 404);
});

test("a failing or coded detail read keeps its own status", async (t) => {
  const sensitive = "C:/private/session.jsonl";
  const coded = await fixture(t, {
    readTaskDetail: async () => { throw Object.assign(new Error(`cannot read ${sensitive}`), { status: 404 }); },
  });
  const codedUrl = coded.snapshotsUrl.replace("pending-snapshots", "tasks") + "/task-1/detail";
  const notFound = await request(codedUrl, { headers: coded.headers });
  assert.equal(notFound.status, 404);

  const failing = await fixture(t, {
    readTaskDetail: async () => { throw new Error(`cannot read ${sensitive}`); },
  });
  const failingUrl = failing.snapshotsUrl.replace("pending-snapshots", "tasks") + "/task-1/detail";
  const response = await request(failingUrl, { headers: failing.headers });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "BACKEND_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(body).includes(sensitive));
});

test("a non-function detail reader is rejected at creation", () => {
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), readTaskDetail: "nope" }),
    /readTaskDetail must be a function/,
  );
});

test("serves the Backend's own Bot view and 404s an unknown Bot", async (t) => {
  const bots = [{ id: "bot-1", name: "first" }, { id: "bot-2", name: "second" }];
  const { snapshotsUrl, headers } = await fixture(t, {
    readBots: () => bots,
    readBot: (id) => bots.find((bot) => bot.id === id) ?? null,
  });
  const botsUrl = snapshotsUrl.replace("pending-snapshots", "bots");
  const list = await request(botsUrl, { headers });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { bots });
  const one = await request(`${botsUrl}/bot-2`, { headers });
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), { bot: { id: "bot-2", name: "second" } });
  assert.equal((await request(`${botsUrl}/nope`, { headers })).status, 404);
  assert.equal((await request(`${botsUrl}/`, { headers })).status, 404, "an empty id is not a Bot");
});

test("the Bot view needs authentication and the protocol header, and never leaks a path", async (t) => {
  const sensitive = "C:/private/bots";
  const { snapshotsUrl, headers } = await fixture(t, {
    readBots: () => { throw new Error(`cannot read ${sensitive}`); },
    readBot: () => { throw new Error(`cannot read ${sensitive}`); },
  });
  const botsUrl = snapshotsUrl.replace("pending-snapshots", "bots");
  assert.equal((await request(botsUrl)).status, 401);
  assert.equal((await request(botsUrl, { headers: { authorization: headers.authorization } })).status, 409);
  const failing = await request(botsUrl, { headers });
  assert.equal(failing.status, 500);
  const body = await failing.json();
  assert.equal(body.code, "BACKEND_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(body).includes(sensitive));
  assert.equal((await request(`${botsUrl}/bot-1`, { headers })).status, 500);
});

test("a non-function Bot reader is rejected at creation", () => {
  for (const options of [{ readBots: "nope" }, { readBot: 42 }]) {
    assert.throws(
      () => createBackendServer({ token: randomBytes(32).toString("base64url"), ...options }),
      /must be a function/,
    );
  }
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

test("CLI serves the pending snapshot route with an empty store and stays not ready", { timeout: 5_000 }, async (t) => {
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
  const headers = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) };
  const snapshots = await request(`http://127.0.0.1:${listening.port}${BACKEND_PENDING_SNAPSHOTS_PATH}`, { headers });
  assert.equal(snapshots.status, 200);
  // Nothing has scheduled a snapshot in this process yet, so the read is empty.
  assert.deepEqual(await snapshots.json(), { snapshots: [] });
  const health = await request(`http://127.0.0.1:${listening.port}${BACKEND_HEALTH_PATH}`, { headers });
  assert.equal(health.status, 503, "attaching a store must not imply runtime readiness");
  assert.equal((await health.json()).status, "starting");
  assert.equal((await request(`http://127.0.0.1:${listening.port}${BACKEND_PENDING_SNAPSHOTS_PATH}`)).status, 401);
});

/** Spawns the CLI against a temp data directory and returns its listening address and token. */
async function spawnCli(t, extraEnv = {}) {
  const token = randomBytes(32).toString("base64url");
  const dataDir = mkdtempSync(join(tmpdir(), "leafcode-backend-cli-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./entry.mjs", import.meta.url))], {
    env: {
      ...process.env,
      // Keep the real store, leases and sessions untouched.
      NODE_ENV: "test",
      LEAFCODE_PI_DATA_DIR: dataDir,
      LEAFCODE_PI_BACKEND_TOKEN: token,
      LEAFCODE_PI_BACKEND_PORT: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const [line] = await once(lines, "line");
  const listening = JSON.parse(line);
  return {
    listening,
    headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) },
    healthUrl: `http://127.0.0.1:${listening.port}${BACKEND_HEALTH_PATH}`,
  };
}

/** Polls health until it reports the expected readiness, or the deadline passes. */
async function healthUntil(url, headers, expectedStatus, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await request(url, { headers });
    last = await response.json();
    if (response.status === expectedStatus) return { status: response.status, body: last };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { status: null, body: last };
}

test("the CLI stays not ready while the runtime is not requested", { timeout: 15_000 }, async (t) => {
  const cli = await spawnCli(t);
  const health = await request(cli.healthUrl, { headers: cli.headers });
  assert.equal(health.status, 503);
  assert.equal((await health.json()).status, "starting");
});

test("requesting the runtime makes the CLI ready once it is attached", { timeout: 60_000 }, async (t) => {
  const cli = await spawnCli(t, { LEAFCODE_PI_BACKEND_RUNTIME: "attach" });
  const health = await healthUntil(cli.healthUrl, cli.headers, 200);
  assert.equal(health.status, 200, `health never became ready: ${JSON.stringify(health.body)}`);
  assert.equal(health.body.ready, true);
  assert.equal(health.body.status, "ready");
});

test("a missing runtime bundle keeps the CLI at 503 instead of failing to start", { timeout: 15_000 }, async (t) => {
  const cli = await spawnCli(t, {
    LEAFCODE_PI_BACKEND_RUNTIME: "attach",
    LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: join(tmpdir(), "leafcode-no-such-bundle.mjs"),
  });
  const health = await request(cli.healthUrl, { headers: cli.headers });
  assert.equal(health.status, 503);
  const body = await health.json();
  assert.equal(body.ready, false);
  assert.equal(body.status, "starting");
  assert.ok(!JSON.stringify(body).includes("leafcode-no-such-bundle"), "the bundle path is never echoed");
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
