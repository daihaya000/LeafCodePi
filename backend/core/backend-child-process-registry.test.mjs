import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { BACKEND_CHILD_PROCESS_MESSAGE } from "../../shared/backend-child-process-message.mjs";
import { processStartKey } from "../../shared/process-identity.mjs";
import { registerBackendChildProcess } from "./backend-child-process-registry.mjs";
import { processStartKey as runtimeOwnerProcessStartKey } from "./runtime-owner-lock.mjs";

test("shared process identity matches the Backend runtime-owner key format", () => {
  assert.equal(processStartKey(process.pid), runtimeOwnerProcessStartKey(process.pid));
});

test("reports the owned child identity to Host and removes it when the child closes", async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  const messages = [];
  const registration = await registerBackendChildProcess(child, {
    send: (message, callback) => { messages.push(message); callback?.(null); },
    getProcessStartKey: (pid) => `test:${pid}`,
  });

  assert.deepEqual(registration, { token: messages[0].token, pid: 4321 });
  assert.deepEqual(messages[0], {
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action: "started",
    token: registration.token,
    pid: 4321,
    processKey: null,
  });
  assert.deepEqual(messages[1], {
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action: "identity",
    token: registration.token,
    pid: 4321,
    processKey: "test:4321",
  });
  child.emit("close");
  assert.deepEqual(messages[2], {
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action: "stopped",
    token: registration.token,
    pid: 4321,
    processKey: null,
  });
});

test("reports a live child with unknown identity so Host can fail closed", async () => {
  const child = new EventEmitter();
  child.pid = 4322;
  child.exitCode = null;
  child.signalCode = null;
  const messages = [];

  await registerBackendChildProcess(child, {
    send: (message, callback) => { messages.push(message); callback?.(null); },
    getProcessStartKey: () => undefined,
  });

  assert.equal(messages[0]?.processKey, null);
  assert.equal(messages[0]?.action, "started");
  assert.equal(messages[1]?.processKey, null);
  assert.equal(messages[1]?.action, "identity");
  child.emit("close");
});

test("registration send failure is surfaced instead of silently losing cleanup ownership", async () => {
  const child = new EventEmitter();
  child.pid = 4325;
  child.exitCode = null;
  child.signalCode = null;
  await assert.rejects(registerBackendChildProcess(child, {
    send: (_message, callback) => callback(new Error("disconnected")),
    getProcessStartKey: () => "key",
  }), /registration failed/);
  assert.equal(child.listenerCount("close"), 0);
});

test("reports a child that already exited so Host can check for residual process-group members", async () => {
  const closed = new EventEmitter();
  closed.pid = 4323;
  closed.exitCode = 0;
  closed.signalCode = null;
  let keyLookups = 0;
  const messages = [];
  const registration = await registerBackendChildProcess(closed, {
    send: (message, callback) => { messages.push(message); callback?.(null); },
    getProcessStartKey: () => { keyLookups += 1; return "key"; },
  });
  assert.deepEqual(messages.map((message) => message.action), ["started", "stopped"]);
  assert.equal(registration?.pid, 4323);
  assert.equal(keyLookups, 0);

  const live = new EventEmitter();
  live.pid = 4324;
  live.exitCode = null;
  live.signalCode = null;
  assert.equal(await registerBackendChildProcess(live, {
    send: null,
    getProcessStartKey: () => { keyLookups += 1; return "key"; },
  }), null);
  assert.equal(keyLookups, 0);
});
