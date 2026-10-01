import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackendServer, closeBackend } from "./server.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION, BACKEND_RUNTIME_CONTROL_PATH } from "../../shared/backend-protocol.mjs";

async function fixture(t, options = {}) {
  const server = createBackendServer({ token: "test-token-that-is-at-least-32-chars", ...options });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  t.after(() => closeBackend(server));
  return { url: `http://127.0.0.1:${address.port}${BACKEND_RUNTIME_CONTROL_PATH}`, headers: { authorization: "Bearer test-token-that-is-at-least-32-chars", [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) } };
}
test("runtime state is authenticated and reads the owner's live loops", async (t) => {
  const { url, headers } = await fixture(t, { readRuntimeState: () => ({ taskIds: ["owner-loop"] }) });
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { taskIds: ["owner-loop"] });
});
test("validated setting changes execute in the runtime owner", async (t) => {
  const calls = [];
  const { url, headers } = await fixture(t, { runtimeControlAction: (body) => { calls.push(body); return "saved"; } });
  const post = (body) => fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await post({ action: "set-cache-warming", value: "off" });
  assert.deepEqual(await response.json(), { result: "saved" });
  assert.deepEqual(calls, [{ action: "set-cache-warming", value: "off" }]);
  assert.equal((await post({ action: "set-compaction", value: "false" })).status, 400);
  assert.equal((await post({ action: "set-cache-warming", value: "unknown" })).status, 400);
  assert.equal((await post({ action: "execute-arbitrary-function" })).status, 400);
  assert.equal(calls.length, 1);
});
test("an unavailable owner never answers that no loops exist", async (t) => {
  const { url, headers } = await fixture(t);
  assert.equal((await fetch(url, { headers })).status, 503);
});
