import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createBackendServer, closeBackend } from "./server.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_RUNTIME_EVENTS_PATH } from "../../shared/backend-protocol.mjs";

test("owner Bot/routine events cross HTTP and disconnect releases both subscriptions", async (t) => {
  const owner = new EventEmitter();
  const server = createBackendServer({ token: "test-token-that-is-at-least-32-chars", isReady: () => true,
    subscribeRuntimeEvents: (listener) => { owner.on("event", listener); return () => owner.off("event", listener); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeBackend(server));
  const url = `http://127.0.0.1:${server.address().port}${BACKEND_RUNTIME_EVENTS_PATH}`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { authorization: "Bearer test-token-that-is-at-least-32-chars", [BACKEND_PROTOCOL_HEADER]: "1" } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read(); // connected comment; neither event is generated in the Web process.
  owner.emit("event", { event: "routine", payload: { botId: "bot", ok: true } });
  owner.emit("event", { event: "snapshot", payload: { eventType: "code_session_changed" } });
  owner.emit("event", { event: "task_dirty", payload: { taskId: "task-1", reason: "prompt_accepted" } });
  let text = "";
  while (!text.includes("task_dirty") || !text.includes("code_session_changed")) {
    text += new TextDecoder().decode((await reader.read()).value);
  }
  assert.match(text, /event: routine/);
  assert.match(text, /event: snapshot/);
  assert.match(text, /event: task_dirty/);
  assert.match(text, /task-1/);
  await reader.cancel();
  for (let i = 0; i < 20 && owner.listenerCount("event") > 0; i++) await delay(10);
  assert.equal(owner.listenerCount("event"), 0);
});
