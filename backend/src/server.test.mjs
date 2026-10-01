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
import { loadBackendRuntime } from "./runtime-loader.mjs";
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

test("health reports the startup steps this build cannot run yet", async (t) => {
  const { url, headers } = await fixture(t, {
    isReady: () => true,
    runtimeStartupIncomplete: () => ["startBotCodeRelay", "ensureRoutineScheduler"],
  });
  const response = await request(url, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).runtimeStartupIncomplete, ["startBotCodeRelay", "ensureRoutineScheduler"]);
  const empty = await fixture(t, { isReady: () => true });
  assert.deepEqual((await (await request(empty.url, { headers: empty.headers })).json()).runtimeStartupIncomplete, []);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), runtimeStartupIncomplete: "nope" }),
    /runtimeStartupIncomplete/,
  );
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

test("health reports the runtime generation so a stale Backend is detectable", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t, { isReady: () => true, runtimeGeneration: () => "gen-abc" });
  const body = await (await request(snapshotsUrl.replace("pending-snapshots", "health"), { headers })).json();
  assert.equal(body.runtimeGeneration, "gen-abc");
  const detached = await fixture(t, { isReady: () => true });
  const detachedBody = await (await request(detached.snapshotsUrl.replace("pending-snapshots", "health"), { headers: detached.headers })).json();
  assert.equal(detachedBody.runtimeGeneration, null);
});

test("health reports the pinned generation alongside the running one", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t, {
    isReady: () => true,
    runtimeGeneration: () => "gen-b",
    runtimeGenerationPinned: () => "gen-a",
  });
  const body = await (await request(snapshotsUrl.replace("pending-snapshots", "health"), { headers })).json();
  assert.equal(body.runtimeGeneration, "gen-b");
  assert.equal(body.runtimeGenerationPinned, "gen-a");
  const unpinned = await fixture(t, { isReady: () => true, runtimeGeneration: () => "gen-b" });
  const unpinnedBody = await (await request(unpinned.snapshotsUrl.replace("pending-snapshots", "health"), { headers: unpinned.headers })).json();
  assert.equal(unpinnedBody.runtimeGenerationPinned, null);
});

test("a non-function generation reader is rejected at creation", () => {
  for (const options of [{ runtimeGeneration: 7 }, { runtimeGenerationPinned: "gen-a" }]) {
    assert.throws(
      () => createBackendServer({ token: randomBytes(32).toString("base64url"), ...options }),
      /must be a function/,
    );
  }
});

test("a forwarded prompt reaches the runtime and answers with the task summary", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    promptTask: async (id, body) => {
      seen.push({ id, body });
      return { id, agent: "builder", status: "working" };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/prompt`;
  const response = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "こんにちは", model: "openai/gpt-5" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { task: { id: "task-1", agent: "builder", status: "working" } });
  assert.deepEqual(seen, [{ id: "task-1", body: { prompt: "こんにちは", model: "openai/gpt-5" } }]);
});

test("a forwarded prompt is refused when nothing owns the runtime", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t);
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/prompt`;
  const response = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "BACKEND_RUNTIME_UNAVAILABLE");
  // A GET on the prompt path is a method error, not a task read.
  assert.equal((await request(url, { headers })).status, 405);
});

test("an unusable prompt body is refused without calling the runtime", async (t) => {
  let calls = 0;
  const { snapshotsUrl, headers } = await fixture(t, { promptTask: async () => { calls += 1; return { id: "task-1" }; } });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/prompt`;
  const post = (body, contentType = "application/json") =>
    request(url, { method: "POST", headers: { ...headers, "content-type": contentType }, body });
  assert.equal((await post("")).status, 400, "an empty body is not a prompt");
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post(JSON.stringify({ prompt: "x" }), "text/plain")).status, 200, "content type is not enforced");
  assert.equal(calls, 1);
  assert.equal((await request(`${snapshotsUrl.replace("pending-snapshots", "tasks")}//prompt`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x" }),
  })).status, 404, "an empty id is not a task");
});

test("a failing prompt reports a status without leaking the exception text", async (t) => {
  const secret = "sk-secret-credential";
  const { snapshotsUrl, headers } = await fixture(t, {
    promptTask: async () => {
      throw Object.assign(new Error(`provider rejected ${secret}`), { status: 409 });
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/prompt`;
  const response = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "BACKEND_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(body).includes(secret));
});

test("the prompt endpoint needs authentication and the protocol header", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t, { promptTask: async () => ({ id: "task-1" }) });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/prompt`;
  const body = JSON.stringify({ prompt: "hi" });
  assert.equal((await request(url, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
  const withoutProtocol = { authorization: headers.authorization, "content-type": "application/json" };
  assert.equal((await request(url, { method: "POST", headers: withoutProtocol, body })).status, 409, "the protocol header is required");
});

test("a non-function prompt handler is rejected at creation", () => {
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), promptTask: "nope" }),
    /promptTask must be a function or null/,
  );
});

test("a forwarded approval reaches the runtime, and an unknown request is a 404", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    respondToPermission: async (id, requestId, approved) => {
      seen.push({ id, requestId, approved });
      return requestId === "req-1";
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/permission`;
  const post = (body) =>
    request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const ok = await post({ requestId: "req-1", approved: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.deepEqual(seen, [{ id: "task-1", requestId: "req-1", approved: true }]);
  assert.equal((await post({ requestId: "other", approved: false })).status, 404);
  assert.equal((await post({ requestId: "req-1" })).status, 400, "approved must be a boolean");
  assert.equal((await post({ approved: true })).status, 400, "requestId is required");
});

test("a forwarded question answer reaches the runtime, with rejection as a null answer", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    respondToQuestion: async (id, requestId, answer) => {
      seen.push({ id, requestId, answer });
      return true;
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/question`;
  const post = (body) =>
    request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ requestId: "q1", answer: { answers: [["はい"]] } })).status, 200);
  assert.equal((await post({ requestId: "q2" })).status, 200, "a missing answer is a rejection");
  assert.equal((await post({ answer: { answers: [] } })).status, 400, "requestId is required");
  assert.deepEqual(seen, [
    { id: "task-1", requestId: "q1", answer: { answers: [["はい"]] } },
    { id: "task-1", requestId: "q2", answer: null },
  ]);
});

test("the answering endpoints need a runtime and are POST-only", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t);
  for (const suffix of ["permission", "question"]) {
    const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/${suffix}`;
    const response = await request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ requestId: "r" }) });
    assert.equal(response.status, 503, suffix);
    assert.equal((await response.json()).code, "BACKEND_RUNTIME_UNAVAILABLE");
    assert.equal((await request(url, { headers })).status, 405, suffix);
  }
});

test("a non-function approval handler is rejected at creation", () => {
  for (const options of [{ respondToPermission: "nope" }, { respondToQuestion: 1 }]) {
    assert.throws(
      () => createBackendServer({ token: randomBytes(32).toString("base64url"), ...options }),
      /must be a function or null/,
    );
  }
});

test("a forwarded abort stops the session, with the Bot-owned path kept", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    abortTask: async (id, botId) => {
      seen.push({ id, botId });
      return botId === "missing" ? null : { id, status: "error" };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/abort`;
  const post = (body) =>
    request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const plain = await post({});
  assert.equal(plain.status, 200);
  assert.deepEqual(await plain.json(), { task: { id: "task-1", status: "error" } });
  assert.equal((await post({ botId: "bot-1" })).status, 200);
  assert.equal((await post({ botId: "missing" })).status, 404, "nothing to stop is a 404");
  assert.deepEqual(seen, [
    { id: "task-1", botId: null },
    { id: "task-1", botId: "bot-1" },
    { id: "task-1", botId: "missing" },
  ]);
});

test("an abort without a body is accepted, and without a runtime it is a 503", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t, { abortTask: async (id) => ({ id, status: "error" }) });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/abort`;
  assert.equal((await request(url, { method: "POST", headers })).status, 200, "no body at all is fine");
  const detached = await fixture(t);
  const detachedUrl = `${detached.snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/abort`;
  const response = await request(detachedUrl, { method: "POST", headers: detached.headers });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "BACKEND_RUNTIME_UNAVAILABLE");
  assert.equal((await request(detachedUrl, { headers: detached.headers })).status, 405);
});

test("a non-function abort handler is rejected at creation", () => {
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), abortTask: 7 }),
    /must be a function or null/,
  );
});

test("a forwarded Bot Code request action reaches the outbox owner", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    botCodeRequestAction: async (botId, body) => {
      seen.push({ botId, body });
      return body.requestId === "missing" ? null : { requestId: body.requestId, state: "cancelled" };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/code-requests`;
  const post = (body) =>
    request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const ok = await post({ action: "abort", requestId: "req-1" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { requestId: "req-1", state: "cancelled" });
  assert.equal((await post({ action: "abort", requestId: "missing" })).status, 404);
  assert.deepEqual(seen, [
    { botId: "bot-1", body: { action: "abort", requestId: "req-1" } },
    { botId: "bot-1", body: { action: "abort", requestId: "missing" } },
  ]);
  // A Bot read is still a GET on the plain Bot path.
  assert.equal((await request(url, { headers })).status, 405, "the action path is POST-only");
});

test("the Bot Code request action needs a runtime, and a non-function handler is rejected", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t);
  const url = `${snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/code-requests`;
  const response = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "abort", requestId: "req-1" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "BACKEND_RUNTIME_UNAVAILABLE");
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), botCodeRequestAction: "nope" }),
    /must be a function or null/,
  );
});

test("a forwarded Goal Loop control reaches the loop's owner", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    goalLoopAction: async (id, body) => {
      seen.push({ id, body });
      if (body.action === "start") {
        return { loop: { id, status: "queued" }, agent: "reviewer", autoDecision: { modelID: "selected-model" } };
      }
      return body.action === "stop" && body.botId === "missing" ? null : { id, status: "paused" };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/goal-loop`;
  const post = (body) =>
    request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const paused = await post({ action: "pause" });
  assert.equal(paused.status, 200);
  assert.deepEqual(await paused.json(), { loop: { id: "task-1", status: "paused" } });
  assert.equal((await post({ action: "resume", maxTurns: 5 })).status, 200);
  assert.equal((await post({ action: "stop", botId: "bot-1" })).status, 200);
  assert.equal((await post({ action: "stop", botId: "missing" })).status, 404, "an unknown loop is a 404");
  const started = await post({ action: "start", goal: "直して", acceptance: ["テストが通る"], auto: true, agent: "auto" });
  assert.equal(started.status, 200, "start is forwarded too");
  assert.deepEqual(await started.json(), {
    loop: { id: "task-1", status: "queued" }, agent: "reviewer", autoDecision: { modelID: "selected-model" },
  });
  assert.deepEqual(seen, [
    { id: "task-1", body: { action: "pause" } },
    { id: "task-1", body: { action: "resume", maxTurns: 5 } },
    { id: "task-1", body: { action: "stop", botId: "bot-1" } },
    { id: "task-1", body: { action: "stop", botId: "missing" } },
    { id: "task-1", body: { action: "start", goal: "直して", acceptance: ["テストが通る"], auto: true, agent: "auto" } },
  ]);
});

test("a Bot Goal Loop start carries the Bot identity and rejects a mismatched task", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    goalLoopAction: async (id, body) => {
      seen.push({ id, body });
      return { loop: { status: "queued" }, agent: null };
    },
  });
  const post = (id, botId) => request(`${snapshotsUrl.replace("pending-snapshots", "tasks")}/${encodeURIComponent(id)}/goal-loop`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "start", botId, goal: "調べる", acceptance: [] }),
  });
  const started = await post("bot:one", "one");
  assert.equal(started.status, 200);
  assert.deepEqual(await started.json(), { loop: { status: "queued" }, agent: null });
  assert.equal((await post("task-1", "one")).status, 400);
  assert.equal((await post("bot:one", "two")).status, 400);
  assert.equal((await post("bot:one", 5)).status, 400);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "bot:one");
  assert.equal(seen[0].body.botId, "one");
});

test("Goal Loop start refusals retain their status without leaking runtime errors", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t, {
    goalLoopAction: async (_id, body) => {
      throw Object.assign(new Error("private provider details"), { status: body.auto ? 400 : 409 });
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/goal-loop`;
  for (const [auto, status] of [[true, 400], [false, 409]]) {
    const response = await request(url, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: "start", goal: "直す", auto }),
    });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error, "Backend task action failed");
    assert.equal(JSON.stringify(body).includes("private provider details"), false);
  }
});

test("the Goal Loop control needs a runtime and refuses a non-function handler", async (t) => {
  const { snapshotsUrl, headers } = await fixture(t);
  const url = `${snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/goal-loop`;
  const response = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "pause" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "BACKEND_RUNTIME_UNAVAILABLE");
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), goalLoopAction: 5 }),
    /must be a function or null/,
  );
});

test("forwarded session settings reach the owner with their own validation", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    setTaskModelAction: async (id, model) => { seen.push(["model", id, model]); return { id, modelID: model }; },
    setTaskThinkingLevelAction: async (id, level) => { seen.push(["thinking", id, level]); return { id, thinkingLevel: level }; },
    setTaskAgentAction: async (id, agent) => { seen.push(["agent", id, agent]); return { id, agent }; },
  });
  const base = snapshotsUrl.replace("pending-snapshots", "tasks");
  const post = (path, body) => request(`${base}/task-1${path}`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.deepEqual(await (await post("/model", { model: "chosen" })).json(), { task: { id: "task-1", modelID: "chosen" } });
  assert.deepEqual(await (await post("/thinking", { thinkingLevel: "high" })).json(), { task: { id: "task-1", thinkingLevel: "high" } });
  // An empty agent is meaningful: it clears the selection instead of being refused.
  assert.deepEqual(await (await post("/agent", { agent: "" })).json(), { task: { id: "task-1", agent: "" } });
  assert.deepEqual(seen, [
    ["model", "task-1", "chosen"],
    ["thinking", "task-1", "high"],
    ["agent", "task-1", ""],
  ]);
  // Each field keeps the route's own rule: a blank model or missing level is refused, a non-string
  // agent too.
  assert.equal((await post("/model", { model: "  " })).status, 400);
  assert.equal((await post("/thinking", {})).status, 400);
  assert.equal((await post("/agent", { agent: 5 })).status, 400);
  const missing = await fixture(t, { setTaskModelAction: async () => null });
  assert.equal((await request(`${missing.snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/model`, {
    method: "POST", headers: { ...missing.headers, "content-type": "application/json" }, body: JSON.stringify({ model: "chosen" }),
  })).status, 404);
  const detached = await fixture(t);
  assert.equal((await request(`${detached.snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/model`, {
    method: "POST", headers: { ...detached.headers, "content-type": "application/json" }, body: JSON.stringify({ model: "chosen" }),
  })).status, 503);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), setTaskAgentAction: 5 }),
    /setTaskAgentAction must be a function or null/,
  );
});

test("a forwarded compaction runs and stops in the owner", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    compactTaskAction: async (id, customInstructions) => {
      seen.push(["compact", id, customInstructions]);
      return { id, isCompacting: true };
    },
    abortCompactTaskAction: async (id) => {
      seen.push(["abort", id]);
      return { id, isCompacting: false };
    },
  });
  const base = snapshotsUrl.replace("pending-snapshots", "tasks");
  const post = (url, body) => request(url, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const compacted = await post(`${base}/task-1/compact`, { customInstructions: "要点だけ" });
  assert.equal(compacted.status, 200);
  assert.deepEqual(await compacted.json(), { task: { id: "task-1", isCompacting: true } });
  // An abort takes no input: an empty body is accepted like the task abort.
  const stopped = await post(`${base}/task-1/compact/abort`);
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { task: { id: "task-1", isCompacting: false } });
  assert.deepEqual(seen, [["compact", "task-1", "要点だけ"], ["abort", "task-1"]]);
  // `/compact/abort` must not be parsed as a task abort of `task-1/compact`.
  assert.equal((await request(`${base}/task-1/compact/abort`, { headers })).status, 405);
  const missing = await fixture(t, { compactTaskAction: async () => null });
  assert.equal((await request(`${missing.snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/compact`, {
    method: "POST", headers: { ...missing.headers, "content-type": "application/json" }, body: "{}",
  })).status, 404);
  const detached = await fixture(t);
  assert.equal((await request(`${detached.snapshotsUrl.replace("pending-snapshots", "tasks")}/task-1/compact`, {
    method: "POST", headers: { ...detached.headers, "content-type": "application/json" }, body: "{}",
  })).status, 503);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), compactTaskAction: 5 }),
    /compactTaskAction must be a function or null/,
  );
});

test("forwarded Room admin actions return the owner's own status and body", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    roomAdminPatch: async (roomId, body) => {
      seen.push(["patch", roomId, body]);
      return { status: 400, body: { error: "ルーム設定が不正です" } };
    },
    roomAdminDelete: async (roomId) => {
      seen.push(["delete", roomId]);
      return { status: 200, body: { ok: true } };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "rooms")}/room-1`;
  const patched = await request(url, {
    method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ resetMessages: true }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), { result: { status: 400, body: { error: "ルーム設定が不正です" } } });
  const deleted = await request(url, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { result: { status: 200, body: { ok: true } } });
  assert.deepEqual(seen, [["patch", "room-1", { resetMessages: true }], ["delete", "room-1"]]);
  // GET on the room path is not an admin action, and a nested path is not a room id.
  assert.equal((await request(url, { headers })).status, 405);
  assert.equal((await request(`${url}/extra`, { method: "PATCH", headers })).status, 404);
  const detached = await fixture(t);
  const detachedUrl = `${detached.snapshotsUrl.replace("pending-snapshots", "rooms")}/room-1`;
  assert.equal((await request(detachedUrl, { method: "DELETE", headers: detached.headers })).status, 503);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), roomAdminPatch: 5 }),
    /roomAdminPatch must be a function or null/,
  );
});

test("a forwarded Room prompt returns the owner's own status and body", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    roomPrompt: async (roomId, body) => {
      seen.push({ roomId, body });
      return { status: 403, body: { error: "A valid server relay envelope is required" } };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "rooms")}/room-1/prompt`;
  const post = (body) => request(url, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await post({ prompt: "調べて", fromBot: true });
  // The transport answer is 200: the owner's refusal is replayed by the WebUI, not mislabelled.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    result: { status: 403, body: { error: "A valid server relay envelope is required" } },
  });
  assert.deepEqual(seen, [{ roomId: "room-1", body: { prompt: "調べて", fromBot: true } }]);
  assert.equal((await request(url, { headers })).status, 405);
  const detached = await fixture(t);
  const detachedUrl = `${detached.snapshotsUrl.replace("pending-snapshots", "rooms")}/room-1/prompt`;
  assert.equal((await request(detachedUrl, {
    method: "POST", headers: { ...detached.headers, "content-type": "application/json" }, body: JSON.stringify({ prompt: "調べて" }),
  })).status, 503);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), roomPrompt: 5 }),
    /roomPrompt must be a function or null/,
  );
});

test("a forwarded task revert and unrevert reach the runtime owner", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    revertTaskAction: async (id, entryId) => {
      seen.push(["revert", id, entryId]);
      return { task: { id }, text: "戻した", images: [], files: [] };
    },
    unrevertTaskAction: async (id) => {
      seen.push(["unrevert", id]);
      return { id, revertLeafId: null };
    },
  });
  const base = snapshotsUrl.replace("pending-snapshots", "tasks");
  const post = (url, body) => request(url, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const reverted = await post(`${base}/task-1/revert`, { entryId: "entry-1" });
  assert.equal(reverted.status, 200);
  assert.deepEqual(await reverted.json(), { task: { id: "task-1" }, text: "戻した", images: [], files: [] });
  // Unrevert takes no input: an empty body is accepted like abort.
  const restored = await request(`${base}/task-1/unrevert`, { method: "POST", headers });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), { task: { id: "task-1", revertLeafId: null } });
  assert.deepEqual(seen, [["revert", "task-1", "entry-1"], ["unrevert", "task-1"]]);
  // A missing entry id is refused before the owner is asked, and both routes are POST-only.
  assert.equal((await post(`${base}/task-1/revert`, {})).status, 400);
  assert.equal((await request(`${base}/task-1/unrevert`, { headers })).status, 405);
  // An unknown task is a 404 from the owner's own lookup.
  const missing = await fixture(t, { unrevertTaskAction: async () => null });
  const missingBase = missing.snapshotsUrl.replace("pending-snapshots", "tasks");
  assert.equal((await request(`${missingBase}/task-1/unrevert`, {
    method: "POST", headers: { ...missing.headers, "content-type": "application/json" }, body: "{}",
  })).status, 404);
  const detached = await fixture(t);
  const detachedBase = detached.snapshotsUrl.replace("pending-snapshots", "tasks");
  assert.equal((await request(`${detachedBase}/task-1/revert`, {
    method: "POST", headers: { ...detached.headers, "content-type": "application/json" }, body: JSON.stringify({ entryId: "entry-1" }),
  })).status, 503);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), revertTaskAction: 5 }),
    /revertTaskAction must be a function or null/,
  );
});

test("a forwarded Room revert reaches the runtime owner", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    revertRoom: async (roomId, messageId) => {
      seen.push({ roomId, messageId });
      return {
        room: { id: roomId, messages: [] },
        text: "やり直したい依頼",
        images: [{ file: "room-1-0.png", mimeType: "image/png" }],
        files: [{ file: "room-1-0.dat", mimeType: "text/plain", name: "notes.txt" }],
        cancelledCodeRequests: 2,
      };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "rooms")}/room-1/revert`;
  const post = (body) => request(url, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await post({ messageId: "message-1" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    room: { id: "room-1", messages: [] },
    text: "やり直したい依頼",
    images: [{ file: "room-1-0.png", mimeType: "image/png" }],
    files: [{ file: "room-1-0.dat", mimeType: "text/plain", name: "notes.txt" }],
    cancelledCodeRequests: 2,
  });
  assert.deepEqual(seen, [{ roomId: "room-1", messageId: "message-1" }]);
  // A missing message id is refused before the owner is asked, and the route is POST-only.
  assert.equal((await post({})).status, 400);
  assert.equal((await request(url, { headers })).status, 405);
  const detached = await fixture(t);
  const detachedUrl = `${detached.snapshotsUrl.replace("pending-snapshots", "rooms")}/room-1/revert`;
  assert.equal((await request(detachedUrl, {
    method: "POST", headers: { ...detached.headers, "content-type": "application/json" }, body: JSON.stringify({ messageId: "message-1" }),
  })).status, 503);
  const refusing = await fixture(t, {
    revertRoom: async () => { throw Object.assign(new Error("no such message"), { status: 404 }); },
  });
  const refusingUrl = `${refusing.snapshotsUrl.replace("pending-snapshots", "rooms")}/room-1/revert`;
  assert.equal((await request(refusingUrl, {
    method: "POST", headers: { ...refusing.headers, "content-type": "application/json" }, body: JSON.stringify({ messageId: "message-1" }),
  })).status, 404);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), revertRoom: 5 }),
    /revertRoom must be a function or null/,
  );
});

test("a forwarded Bot revert reaches the runtime owner", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    revertBotTask: async (botId, entryId) => {
      seen.push({ botId, entryId });
      return { task: { id: `bot:${botId}` }, text: "戻した", images: [], files: [], cancelledCodeRequests: 2 };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/revert`;
  const post = (body) => request(url, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await post({ entryId: "entry-1" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    task: { id: "bot:bot-1" }, text: "戻した", images: [], files: [], cancelledCodeRequests: 2,
  });
  assert.deepEqual(seen, [{ botId: "bot-1", entryId: "entry-1" }]);
  // A missing entry id is refused before the runtime is asked, and the route is POST-only.
  assert.equal((await post({})).status, 400);
  assert.equal((await request(url, { headers })).status, 405);
  const detached = await fixture(t);
  const detachedUrl = `${detached.snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/revert`;
  assert.equal((await request(detachedUrl, {
    method: "POST", headers: { ...detached.headers, "content-type": "application/json" }, body: JSON.stringify({ entryId: "entry-1" }),
  })).status, 503);
  const refusing = await fixture(t, {
    revertBotTask: async () => { throw Object.assign(new Error("busy"), { status: 409 }); },
  });
  const refusingUrl = `${refusing.snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/revert`;
  assert.equal((await request(refusingUrl, {
    method: "POST", headers: { ...refusing.headers, "content-type": "application/json" }, body: JSON.stringify({ entryId: "entry-1" }),
  })).status, 409);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), revertBotTask: 5 }),
    /revertBotTask must be a function or null/,
  );
});

test("a forwarded routine run reaches the runtime owner", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    runBotRoutine: async (botId, routineId) => {
      seen.push({ botId, routineId });
      return { id: routineId, name: "朝の確認" };
    },
  });
  const botsUrl = snapshotsUrl.replace("pending-snapshots", "bots");
  const url = `${botsUrl}/bot-1/routines/routine-1`;
  const response = await request(url, { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { routine: { id: "routine-1", name: "朝の確認" } });
  assert.deepEqual(seen, [{ botId: "bot-1", routineId: "routine-1" }]);
  // GET cannot run a routine, and ids are decoded per segment so a slash cannot move the path.
  assert.equal((await request(url, { headers })).status, 405);
  const encoded = [];
  const encodedFixture = await fixture(t, {
    runBotRoutine: async (botId, routineId) => { encoded.push([botId, routineId]); return { id: routineId }; },
  });
  const encodedUrl = `${encodedFixture.snapshotsUrl.replace("pending-snapshots", "bots")}/bot%2Fone/routines/routine%2F1`;
  assert.deepEqual(await (await request(encodedUrl, { method: "POST", headers: encodedFixture.headers })).json(), {
    routine: { id: "routine/1" },
  });
  assert.deepEqual(encoded, [["bot/one", "routine/1"]]);
});

test("a routine run reports a miss, a refusal and a detached runtime", async (t) => {
  const missing = await fixture(t, { runBotRoutine: async () => null });
  const missingUrl = `${missing.snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/routines/none`;
  assert.equal((await request(missingUrl, { method: "POST", headers: missing.headers })).status, 404);
  const busy = await fixture(t, {
    runBotRoutine: async () => { throw Object.assign(new Error("another worker"), { status: 409 }); },
  });
  const busyUrl = `${busy.snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/routines/routine-1`;
  const busyResponse = await request(busyUrl, { method: "POST", headers: busy.headers });
  assert.equal(busyResponse.status, 409);
  assert.equal((await busyResponse.json()).error, "Backend routine run failed");
  const detached = await fixture(t);
  const detachedUrl = `${detached.snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/routines/routine-1`;
  assert.equal((await request(detachedUrl, { method: "POST", headers: detached.headers })).status, 503);
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), runBotRoutine: 5 }),
    /runBotRoutine must be a function or null/,
  );
});

test("a forwarded Bot Code session is created by the runtime owner", async (t) => {
  const seen = [];
  const { snapshotsUrl, headers } = await fixture(t, {
    createBotCodeSession: async (botId, input) => {
      seen.push({ botId, input });
      // Clearing a link answers with no task, like the WebUI's owning path.
      if (input.action === "clear" || input.action === "unlink") return null;
      return { id: "code-1", status: "working", botId };
    },
  });
  const url = `${snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/code-sessions`;
  const response = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "やって", projectId: "project-1", permissionMode: "ask" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { task: { id: "code-1", status: "working", botId: "bot-1" } });
  assert.deepEqual(seen, [
    { botId: "bot-1", input: { prompt: "やって", projectId: "project-1", permissionMode: "ask" } },
  ]);
  const continued = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "continue", taskId: "code-1", prompt: "続けて" }),
  });
  assert.equal(continued.status, 200);
  assert.deepEqual(seen.at(-1), {
    botId: "bot-1",
    input: { action: "continue", taskId: "code-1", prompt: "続けて" },
  });
  const cleared = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "clear", taskId: "code-1" }),
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { task: null });
  assert.deepEqual(seen.at(-1), { botId: "bot-1", input: { action: "clear", taskId: "code-1" } });
  const detached = await fixture(t);
  const detachedUrl = `${detached.snapshotsUrl.replace("pending-snapshots", "bots")}/bot-1/code-sessions`;
  const refused = await request(detachedUrl, {
    method: "POST",
    headers: { ...detached.headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "やって" }),
  });
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).code, "BACKEND_RUNTIME_UNAVAILABLE");
  assert.throws(
    () => createBackendServer({ token: randomBytes(32).toString("base64url"), createBotCodeSession: 1 }),
    /must be a function or null/,
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
    // A test process running inside a live Backend inherits its runtime flag: a detached CLI is what
    // this test is about, so it is cleared explicitly.
    env: {
      ...process.env,
      LEAFCODE_PI_BACKEND_TOKEN: token,
      LEAFCODE_PI_BACKEND_PORT: "0",
      LEAFCODE_PI_BACKEND_RUNTIME: "",
      LEAFCODE_PI_BACKEND_GENERATION: "",
    },
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

test("CLI serves no pending requests with a detached runtime and stays not ready", { timeout: 5_000 }, async (t) => {
  const token = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./entry.mjs", import.meta.url))], {
    env: {
      ...process.env,
      LEAFCODE_PI_BACKEND_TOKEN: token,
      LEAFCODE_PI_BACKEND_PORT: "0",
      LEAFCODE_PI_BACKEND_RUNTIME: "",
      LEAFCODE_PI_BACKEND_GENERATION: "",
    },
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
  // No runtime is attached, so there are no owner-held pending requests to expose.
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
      // Inherited from a live Backend when the suite runs inside one; each test opts in explicitly.
      LEAFCODE_PI_BACKEND_RUNTIME: "",
      LEAFCODE_PI_BACKEND_GENERATION: "",
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

test("the CLI stays not ready while the runtime is not requested", { timeout: 15_000 }, async (t) => {
  const cli = await spawnCli(t);
  const health = await request(cli.healthUrl, { headers: cli.headers });
  assert.equal(health.status, 503);
  assert.equal((await health.json()).status, "starting");
});

test("requesting the runtime attaches it and makes the CLI ready", { timeout: 90_000 }, async (t) => {
  const cli = await spawnCli(t, { LEAFCODE_PI_BACKEND_RUNTIME: "attach" });
  const ready = await readyUntil(cli.healthUrl, cli.headers);
  assert.equal(ready.status, 200, `health never became ready: ${JSON.stringify(ready.body)}`);
  assert.equal(ready.body.ready, true);
  assert.equal(ready.body.status, "ready");
  assert.ok(ready.body.runtimeGeneration, "the runtime never attached");
  // Every startup step ran: nothing is missing and nothing failed to start.
  assert.deepEqual(ready.body.runtimeStartupIncomplete, []);
});

/**
 * Polls health until it reports ready, or the deadline passes. A request that times out is retried:
 * the CLI blocks its event loop while it imports the runtime bundle, so the first poll can be
 * slower than the 2s request timeout.
 */
async function readyUntil(url, headers, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await request(url, { headers });
      last = await response.json();
      if (last?.ready === true) return { status: response.status, body: last };
    } catch {
      // Still attaching; the next poll retries.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { status: null, body: last };
}

/**
 * Polls health until the runtime reports a generation, or the deadline passes. A request that times
 * out is retried: the CLI blocks its event loop while it imports the runtime bundle, so the first
 * poll can be slower than the 2s request timeout.
 */
async function generationUntil(url, headers, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await request(url, { headers });
      last = await response.json();
      if (typeof last.runtimeGeneration === "string" && last.runtimeGeneration) return last;
    } catch {
      // Still attaching; the next poll retries.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

test("a pinned generation the bundle does not have keeps the CLI at 503", { timeout: 90_000 }, async (t) => {
  const cli = await spawnCli(t, {
    LEAFCODE_PI_BACKEND_RUNTIME: "attach",
    LEAFCODE_PI_BACKEND_GENERATION: "gen-not-this-build",
  });
  const body = await generationUntil(cli.healthUrl, cli.headers);
  // The runtime did attach: the refusal is the generation, not a failed attach.
  assert.ok(body?.runtimeGeneration, `the runtime never attached: ${JSON.stringify(body)}`);
  assert.notEqual(body.runtimeGeneration, "gen-not-this-build");
  assert.equal(body.runtimeGenerationPinned, "gen-not-this-build");
  assert.equal(body.ready, false);
  assert.equal(body.status, "starting");
  const health = await request(cli.healthUrl, { headers: cli.headers });
  assert.equal(health.status, 503);
});

test("the CLI becomes ready when the pinned generation is the bundle's own", { timeout: 90_000 }, async (t) => {
  const runtime = await loadBackendRuntime();
  if (!runtime.ok) return t.skip(`no built bundle: ${runtime.reason}`);
  const cli = await spawnCli(t, {
    LEAFCODE_PI_BACKEND_RUNTIME: "attach",
    LEAFCODE_PI_BACKEND_GENERATION: runtime.generation,
  });
  const ready = await readyUntil(cli.healthUrl, cli.headers);
  assert.equal(ready.status, 200, `health never became ready: ${JSON.stringify(ready.body)}`);
  assert.equal(ready.body.runtimeGeneration, runtime.generation);
  assert.equal(ready.body.runtimeGenerationPinned, runtime.generation);
  assert.deepEqual(ready.body.runtimeStartupIncomplete, []);
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
