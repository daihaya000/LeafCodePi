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
test("an unavailable owner never answers that no loops exist", async (t) => {
  const { url, headers } = await fixture(t);
  assert.equal((await fetch(url, { headers })).status, 503);
});
