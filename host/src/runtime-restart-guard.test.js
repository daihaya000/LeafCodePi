import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { backendRuntimeRestartBlockReason } from "./runtime-restart-guard.js";
import { BACKEND_PROTOCOL_HEADER } from "../../shared/backend-protocol.mjs";

const options = { baseUrl: "http://owner.invalid", token: "test", expectedGeneration: "generation" };
function fetchState(body, { status = 200, generation = "generation" } = {}) {
  return async (url) => new Response(JSON.stringify(url.endsWith("/health") ? { ready: true, runtimeGeneration: generation } : body), {
    status: url.endsWith("/health") ? 200 : status, headers: { [BACKEND_PROTOCOL_HEADER]: "1" },
  });
}
test("Backend loops block restart independently of WebUI availability", async () => {
  const reason = await backendRuntimeRestartBlockReason({ ...options, fetchImpl: fetchState({ taskIds: ["loop"] }) });
  assert.match(reason, /Goal Loop/);
});
test("an authoritative empty owner allows a runtime restart", async () => {
  assert.equal(await backendRuntimeRestartBlockReason({ ...options, fetchImpl: fetchState({ taskIds: [] }) }), null);
});
test("a health body that stalls after headers remains bounded and fails closed", { timeout: 5000 }, async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { [BACKEND_PROTOCOL_HEADER]: "1", "content-type": "application/json" });
    res.write('{"ready":true,'); // Headers arrived, but a broken owner never finishes its body.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const reason = await backendRuntimeRestartBlockReason({ ...options, baseUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal(requests, 1);
  assert.equal(typeof reason, "string");
});
test("unreachable, malformed, incompatible and wrong-generation owners fail closed", async () => {
  for (const fetchImpl of [async () => { throw new Error("offline"); }, fetchState({}), fetchState({ taskIds: [] }, { status: 503 }), fetchState({ taskIds: [] }, { generation: "other" })]) {
    assert.equal(typeof await backendRuntimeRestartBlockReason({ ...options, fetchImpl }), "string");
  }
});
