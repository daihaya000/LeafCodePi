import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  createPermissionPromptService, createQuestionPromptService, PendingPromptIdCollisionError,
  PENDING_PROMPT_TIMEOUT_MS, taskIdForSession,
} from "./pending-prompts.mjs";

function timers() {
  const active = new Map();
  let next = 1;
  return {
    active,
    setTimer: (callback, delayMs) => { const id = next++; active.set(id, { callback, delayMs }); return id; },
    clearTimer: (id) => { active.delete(id); },
    fire: (id) => { const timer = active.get(id); active.delete(id); timer.callback(); },
    ids: () => [...active.keys()],
  };
}

function permission(options = {}) {
  const t = timers();
  const emitted = [];
  const service = createPermissionPromptService({
    resolveTaskId: (sessionId) => (sessionId.startsWith("s") ? "task" : null),
    emit: (taskId, payload) => emitted.push({ taskId, ...payload }),
    snapshotExtras: (taskId) => ({ extra: taskId }),
    setTimer: t.setTimer, clearTimer: t.clearTimer, ...options,
  });
  return { service, t, emitted };
}

const perm = (id, sessionId = "s1") => ({ id, sessionId, command: `cmd-${id}`, labels: [id], message: id });
const q = (id, sessionId = "s1") => ({ id, sessionId, questions: [{ question: id, options: [{ label: "A" }] }] });
const isIdCollision = (error) => error instanceof PendingPromptIdCollisionError && error.code === "PENDING_PROMPT_ID_COLLISION";

test("construction and unmapped requests create no timers, events or pending state", async () => {
  const { service, t, emitted } = permission();
  assert.equal(t.active.size, 0);
  assert.equal(await service.handleRequest(perm("orphan", "unknown")), null);
  assert.equal(t.active.size, 0);
  assert.deepEqual(emitted, []);
  assert.deepEqual([...service.pendingTaskIds()], []);
});

test("permission responses preserve request shape, events, extras and FIFO visibility", async () => {
  const { service, emitted } = permission();
  const extra = { ...perm("one"), ignored: "not copied" };
  const first = service.handleRequest(extra);
  const second = service.handleRequest(perm("two"));
  assert.deepEqual(service.pendingForTask("task"), perm("one"));
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], { taskId: "task", type: "snapshot", eventType: "permission_request", permissionRequest: perm("one"), extra: "task" });
  assert.equal(service.respond("task", "two", true), false);
  assert.equal(service.respond("task", "one", true), true);
  assert.equal(await first, true);
  assert.equal(service.pendingForTask("task").id, "two");
  assert.equal(emitted.at(-1).eventType, "permission_request");
  assert.equal(service.respond("task", "one", true), false);
  assert.equal(service.respond("task", "two", false), true);
  assert.equal(await second, false);
  assert.deepEqual(emitted.at(-1), { taskId: "task", type: "snapshot", eventType: "permission_resolved", permissionRequest: null, extra: "task" });
  assert.equal(service.pendingForTask("task"), null);
});

test("only the visible head times out, the promoted request receives a fresh full timeout", async () => {
  const { service, t, emitted } = permission();
  const first = service.handleRequest(perm("one"));
  const second = service.handleRequest(perm("two"));
  const [firstTimer, secondTimer] = t.ids();
  assert.ok([...t.active.values()].every((timer) => timer.delayMs === PENDING_PROMPT_TIMEOUT_MS));
  t.fire(secondTimer);
  assert.equal(service.pendingForTask("task").id, "one");
  assert.equal(emitted.length, 1);
  t.fire(firstTimer);
  assert.equal(await first, false);
  assert.equal(service.pendingForTask("task").id, "two");
  assert.equal(emitted.at(-1).permissionRequest.id, "two");
  assert.equal(t.active.size, 1);
  t.fire(t.ids()[0]);
  assert.equal(await second, false);
  assert.equal(service.respond("task", "two", true), false);
  assert.equal(t.active.size, 0);
});

test("questions preserve answers, null rejection/timeouts and per-task queues", async () => {
  const t = timers();
  const emitted = [];
  const service = createQuestionPromptService({
    resolveTaskId: (sessionId) => sessionId === "a" ? "task-a" : sessionId === "b" ? "task-b" : null,
    emit: (taskId, payload) => emitted.push({ taskId, ...payload }), snapshotExtras: () => ({}),
    setTimer: t.setTimer, clearTimer: t.clearTimer,
  });
  const a1 = service.handleRequest(q("a1", "a"));
  const a2 = service.handleRequest(q("a2", "a"));
  const b1 = service.handleRequest(q("b1", "b"));
  assert.deepEqual([...service.pendingTaskIds()].sort(), ["task-a", "task-b"]);
  assert.equal(service.respond("task-a", "a2", { answers: [["x"]] }), false);
  assert.equal(service.respond("task-a", "a1", { answers: [["日本語"], ["multi", "custom"]] }), true);
  assert.deepEqual(await a1, { answers: [["日本語"], ["multi", "custom"]] });
  assert.equal(service.respond("task-b", "b1", null), true);
  assert.equal(await b1, null);
  assert.equal(emitted.at(-1).eventType, "question_resolved");
  assert.equal(emitted.at(-1).questionRequest, null);
  t.fire(t.ids().at(-1));
  assert.equal(await a2, null);
  assert.equal(t.active.size, 0);
});

test("an id collision with another session rejects explicitly, logs and leaves the original untouched", async () => {
  const warnings = [];
  const { service, emitted } = permission({ warn: (message) => warnings.push(message) });
  const original = service.handleRequest(perm("same", "s1"));
  // A re-send from the same session joins the pending decision without a warning.
  assert.equal(service.handleRequest(perm("same", "s1")), original);
  assert.deepEqual(warnings, []);
  await assert.rejects(service.handleRequest(perm("same", "s2")), isIdCollision);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /id collision.*same/);
  assert.equal(service.pendingForTask("task").sessionId, "s1");
  assert.equal(emitted.length, 1);
  assert.equal(service.respond("task", "same", true), true);
  assert.equal(await original, true);
});

test("abort/dispose refuse every queued item, clear every timer and allow later prompts", async () => {
  const { service, t, emitted } = permission();
  const results = [service.handleRequest(perm("one")), service.handleRequest(perm("two"))];
  assert.equal(service.clearPendingForTask("task"), true);
  assert.deepEqual(await Promise.all(results), [false, false]);
  assert.equal(t.active.size, 0);
  assert.equal(emitted.at(-1).permissionRequest, null);
  assert.equal(service.clearPendingForTask("task"), false);
  const later = service.handleRequest(perm("three"));
  assert.equal(service.pendingForTask("task").id, "three");
  service.dispose();
  assert.equal(await later, false);
  assert.equal(t.active.size, 0);
  assert.deepEqual([...service.pendingTaskIds()], []);
});

test("service instances do not share pending state, IDs or timeout callbacks", async () => {
  const one = permission();
  const two = permission();
  const first = one.service.handleRequest(perm("same"));
  const second = two.service.handleRequest(perm("same"));
  assert.equal(two.service.respond("task", "same", true), true);
  assert.equal(await second, true);
  assert.equal(one.service.pendingForTask("task").id, "same");
  one.t.fire(one.t.ids()[0]);
  assert.equal(await first, false);
  assert.equal(one.emitted.at(-1).eventType, "permission_resolved");
  assert.equal(two.emitted.at(-1).eventType, "permission_resolved");
});

test("a reconnect can redisplay the current head without changing its response", async () => {
  const { service } = permission();
  const decision = service.handleRequest(perm("visible"));
  const snapshotAfterReconnect = service.pendingForTask("task");
  assert.deepEqual(snapshotAfterReconnect, perm("visible"));
  assert.equal(service.respond("task", snapshotAfterReconnect.id, true), true);
  assert.equal(await decision, true);
  assert.equal(service.respond("task", snapshotAfterReconnect.id, false), false);
});

test("session lookup keeps the first matching live entry", () => {
  assert.equal(taskIdForSession("s", [{ taskId: "a", sessionId: "s" }, { taskId: "b", sessionId: "s" }]), "a");
  assert.equal(taskIdForSession("s", [{ taskId: "a", sessionId: undefined }]), null);
});

test("plain Node can run the services with default timers and dispose them without Web imports", () => {
  const moduleUrl = new URL("./pending-prompts.mjs", import.meta.url).href;
  const code = `
    import { createPermissionPromptService } from ${JSON.stringify(moduleUrl)};
    const events = [];
    const service = createPermissionPromptService({
      resolveTaskId: () => "task", emit: (_task, payload) => events.push(payload.eventType), snapshotExtras: () => ({}),
    });
    const decision = service.handleRequest({ id: "one", sessionId: "s", command: "ls", labels: ["ls"], message: "allow?" });
    service.dispose();
    console.log(JSON.stringify({ decision: await decision, events }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  assert.deepEqual(JSON.parse(output), { decision: false, events: ["permission_request"] });
});
