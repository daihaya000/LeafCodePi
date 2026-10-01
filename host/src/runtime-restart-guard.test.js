import assert from "node:assert/strict";
import { test } from "node:test";
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
test("unreachable, malformed, incompatible and wrong-generation owners fail closed", async () => {
  for (const fetchImpl of [async () => { throw new Error("offline"); }, fetchState({}), fetchState({ taskIds: [] }, { status: 503 }), fetchState({ taskIds: [] }, { generation: "other" })]) {
    assert.equal(typeof await backendRuntimeRestartBlockReason({ ...options, fetchImpl }), "string");
  }
});
