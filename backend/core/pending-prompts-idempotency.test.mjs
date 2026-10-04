import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPermissionPromptService, createQuestionPromptService, PendingPromptIdCollisionError,
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

const sessions = { s1: "task-a", s2: "task-b" };
function permission() {
  const t = timers();
  const emitted = [];
  const service = createPermissionPromptService({
    resolveTaskId: (sessionId) => sessions[sessionId] ?? null,
    emit: (taskId, payload) => emitted.push({ taskId, ...payload }),
    snapshotExtras: () => ({}),
    setTimer: t.setTimer, clearTimer: t.clearTimer, warn: () => undefined,
  });
  return { service, t, emitted };
}

const perm = (id, sessionId = "s1") => ({ id, sessionId, command: `cmd-${id}`, labels: [id], message: id });
const question = (id, sessionId = "s1") => ({ id, sessionId, questions: [{ question: id, options: [{ label: "A" }] }] });
const isIdCollision = (error) => error instanceof PendingPromptIdCollisionError && error.code === "PENDING_PROMPT_ID_COLLISION";

test("a re-sent permission request joins the pending decision without a second dialog, event or timer", async () => {
  const { service, t, emitted } = permission();
  const first = service.handleRequest(perm("dup"));
  const again = service.handleRequest(perm("dup"));
  assert.equal(again, first);
  assert.equal(emitted.length, 1);
  assert.equal(t.active.size, 1);
  assert.equal(service.respond("task-a", "dup", true), true);
  assert.equal(await first, true);
  assert.equal(await again, true);
  assert.equal(service.respond("task-a", "dup", false), false);
});

test("a duplicate of a queued (not visible) request joins it and keeps queue order", async () => {
  const { service, emitted } = permission();
  const head = service.handleRequest(perm("head"));
  const queued = service.handleRequest(perm("queued"));
  const queuedAgain = service.handleRequest(perm("queued"));
  assert.equal(queuedAgain, queued);
  assert.equal(emitted.length, 1);
  assert.equal(service.pendingForTask("task-a").id, "head");
  service.respond("task-a", "head", true);
  assert.equal(await head, true);
  assert.equal(service.pendingForTask("task-a").id, "queued");
  service.respond("task-a", "queued", false);
  assert.equal(await queued, false);
  assert.equal(await queuedAgain, false);
  assert.equal(service.pendingForTask("task-a"), null);
});

test("an id collision with another session rejects explicitly and leaves the original intact", async () => {
  const { service, emitted } = permission();
  const original = service.handleRequest(perm("clash", "s1"));
  await assert.rejects(service.handleRequest(perm("clash", "s2")), isIdCollision);
  assert.equal(service.pendingForTask("task-a").id, "clash");
  assert.equal(service.pendingForTask("task-b"), null);
  assert.equal(emitted.length, 1);
  service.respond("task-a", "clash", true);
  assert.equal(await original, true);
});

test("the same task with a different session id is also a collision, not a join", async () => {
  const t = timers();
  const service = createPermissionPromptService({
    resolveTaskId: () => "task-a", emit: () => undefined, snapshotExtras: () => ({}), setTimer: t.setTimer, clearTimer: t.clearTimer, warn: () => undefined,
  });
  const original = service.handleRequest(perm("id", "s1"));
  await assert.rejects(service.handleRequest(perm("id", "s2")), isIdCollision);
  // The original session still joins its own pending request.
  assert.equal(service.handleRequest(perm("id", "s1")), original);
  service.dispose();
  assert.equal(await original, false);
});

test("an id is free again once it was decided, timed out or cleared", async () => {
  const { service, t } = permission();
  const first = service.handleRequest(perm("reuse"));
  service.respond("task-a", "reuse", true);
  assert.equal(await first, true);
  const second = service.handleRequest(perm("reuse"));
  assert.notEqual(second, first);
  t.fire(t.ids()[0]);
  assert.equal(await second, false);
  const third = service.handleRequest(perm("reuse"));
  assert.equal(service.clearPendingForTask("task-a"), true);
  assert.equal(await third, false);
  const fourth = service.handleRequest(perm("reuse"));
  assert.equal(service.pendingForTask("task-a").id, "reuse");
  service.respond("task-a", "reuse", true);
  assert.equal(await fourth, true);
});

test("unmapped sessions are still not remembered and never reach the duplicate check", async () => {
  const { service } = permission();
  assert.equal(await service.handleRequest(perm("ghost", "nobody")), null);
  assert.equal(await service.handleRequest(perm("ghost", "nobody")), null);
  assert.deepEqual([...service.pendingTaskIds()], []);
});

test("questions join duplicates and reject request id collisions explicitly", async () => {
  const t = timers();
  const emitted = [];
  const service = createQuestionPromptService({
    resolveTaskId: (sessionId) => sessions[sessionId] ?? null,
    emit: (taskId, payload) => emitted.push({ taskId, ...payload }), snapshotExtras: () => ({}),
    setTimer: t.setTimer, clearTimer: t.clearTimer, warn: () => undefined,
  });
  const first = service.handleRequest(question("q", "s1"));
  assert.equal(service.handleRequest(question("q", "s1")), first);
  await assert.rejects(service.handleRequest(question("q", "s2")), isIdCollision);
  assert.equal(emitted.length, 1);
  assert.equal(t.active.size, 1);
  service.respond("task-a", "q", { answers: [["A"]] });
  assert.deepEqual(await first, { answers: [["A"]] });
  assert.notEqual(service.handleRequest(question("q", "s1")), first);
});

test("timeout of a joined request resolves every waiter with the refusal", async () => {
  const { service, t } = permission();
  const first = service.handleRequest(perm("slow"));
  const again = service.handleRequest(perm("slow"));
  t.fire(t.ids()[0]);
  assert.equal(await first, false);
  assert.equal(await again, false);
});

test("pending requests are in-memory only: a fresh service after a restart has none and cannot answer old ids", async () => {
  const before = permission();
  const waiting = before.service.handleRequest(perm("across-restart"));
  assert.equal(before.service.pendingForTask("task-a").id, "across-restart");
  // A restarted process builds a new service; nothing is restored from disk or shared state.
  const after = permission();
  assert.equal(after.service.pendingForTask("task-a"), null);
  assert.deepEqual([...after.service.pendingTaskIds()], []);
  assert.equal(after.service.respond("task-a", "across-restart", true), false);
  before.service.dispose();
  assert.equal(await waiting, false);
});
