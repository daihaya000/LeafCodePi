import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendRuntimeRestartBlockReason,
  serviceRestartBusyReason,
  RESTART_BUSY_MESSAGE,
} from "./runtime-restart-guard.js";
import { backendClientEnv, backendLaunchPlan } from "./backend-launch.js";
import { BACKEND_PROTOCOL_HEADER, DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
test("a Backend on its default port still gives the restart guard a usable URL", async () => {
  const plan = backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t", generation: "generation" });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return fetchState({ taskIds: [] })(url);
  };
  const reason = await backendRuntimeRestartBlockReason({
    baseUrl: backendClientEnv(plan).LEAFCODE_PI_BACKEND_URL,
    token: "t",
    expectedGeneration: "generation",
    fetchImpl,
  });
  assert.equal(reason, null);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith(`http://127.0.0.1:${DEFAULT_BACKEND_PORT}/`)));
});
test("a caller that passes no URL falls back to the default port instead of refusing", async () => {
  const urls = [];
  const reason = await backendRuntimeRestartBlockReason({
    token: "t",
    expectedGeneration: "generation",
    fetchImpl: async (url) => {
      urls.push(String(url));
      return fetchState({ taskIds: [] })(url);
    },
  });
  assert.equal(reason, null);
  assert.ok(urls.every((url) => url.startsWith(`http://127.0.0.1:${DEFAULT_BACKEND_PORT}/`)));
});
test("a health body that stalls after headers still fails closed (owner answered headers)", { timeout: 5000 }, async (t) => {
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
  // Headers arrived from a living owner whose body never finishes — fail closed.
  assert.equal(typeof reason, "string");
});
test("unreachable and not-ready owners allow recovery; malformed control answers still fail closed", async () => {
  assert.equal(await backendRuntimeRestartBlockReason({ ...options, fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(
    await backendRuntimeRestartBlockReason({
      ...options,
      fetchImpl: fetchState({ taskIds: [] }, { generation: "other" }),
    }),
    null,
  );
  for (const fetchImpl of [fetchState({}), fetchState({ taskIds: [] }, { status: 503 })]) {
    assert.equal(typeof await backendRuntimeRestartBlockReason({ ...options, fetchImpl }), "string");
  }
});
test("serviceRestartBusyReason reports an in-flight restart", () => {
  assert.equal(serviceRestartBusyReason(false), null);
  assert.equal(serviceRestartBusyReason(true), RESTART_BUSY_MESSAGE);
});
