import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { BACKEND_PROMPT_BODY_LIMIT_BYTES, closeBackend, createBackendServer, listenBackend } from "./server.mjs";

async function fixture(t, options) {
  const server = createBackendServer(options);
  const { port } = await listenBackend(server, 0);
  t.after(async () => { server.closeAllConnections(); await closeBackend(server); });
  return { server, base: `http://127.0.0.1:${port}`, headers: {
    authorization: `Bearer ${options.token}`,
    [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION),
  } };
}

function exchange(url, headers, write, method = "POST") {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.once("error", reject);
    request.setTimeout(1_500, () => request.destroy(new Error("response timed out")));
    write(request);
  });
}

const options = (extra) => ({ token: randomBytes(32).toString("hex"), ...extra });

async function assertHealthy(base, headers) {
  const response = await fetch(`${base}/internal/health`, { headers, signal: AbortSignal.timeout(1_500) });
  assert.equal(response.status, 200);
  await response.json();
}

test("oversized declared prompt is rejected with 413 before any body arrives", async (t) => {
  let calls = 0;
  const { base, headers } = await fixture(t, options({ isReady: () => true, promptTask: () => { calls++; } }));
  const response = await exchange(`${base}/internal/tasks/task-1/prompt`, {
    ...headers, "content-length": String(BACKEND_PROMPT_BODY_LIMIT_BYTES + 1),
  }, (request) => request.flushHeaders());
  assert.equal(response.status, 413);
  assert.equal(response.headers.connection, "close");
  assert.equal(response.body.code, "BACKEND_BAD_REQUEST");
  assert.equal(calls, 0);
  await assertHealthy(base, headers);
});

test("chunked MCP body above its own limit returns 413 instead of a socket reset", async (t) => {
  let calls = 0;
  const { base, headers } = await fixture(t, options({ isReady: () => true,
    setMcpServerEnabledAction: () => { calls++; },
  }));
  const response = await exchange(`${base}/internal/mcp/servers/test`, headers, (request) => {
    request.write(" ".repeat(4096));
    request.end("{}");
  }, "PATCH");
  assert.equal(response.status, 413);
  assert.equal(response.headers.connection, "close");
  assert.equal(calls, 0);
  await assertHealthy(base, headers);
});

test("input-free task actions accept empty bodies but reject malformed JSON", async (t) => {
  const calls = [];
  const handler = (id) => { calls.push(id); return { id }; };
  const { base, headers } = await fixture(t, options({
    abortTask: handler, abortCompactTaskAction: handler, unrevertTaskAction: handler,
  }));
  for (const suffix of ["abort", "compact/abort", "unrevert"]) {
    const url = `${base}/internal/tasks/task-1/${suffix}`;
    const broken = await exchange(url, headers, (request) => request.end("{"));
    assert.equal(broken.status, 400, suffix);
    assert.equal(calls.length, 0, suffix);
  }
  for (const suffix of ["abort", "compact/abort", "unrevert"]) {
    const empty = await exchange(`${base}/internal/tasks/task-1/${suffix}`, headers, (request) => request.end());
    assert.equal(empty.status, 200, suffix);
  }
  assert.equal(calls.length, 3);
});

test("oversized bodies cannot execute input-free actions or routine runs", async (t) => {
  let calls = 0;
  const handler = () => { calls++; return {}; };
  const { base, headers } = await fixture(t, options({
    abortTask: handler, abortCompactTaskAction: handler, unrevertTaskAction: handler, runBotRoutine: handler,
  }));
  for (const [path, limit] of [
    ["/internal/tasks/task-1/abort", BACKEND_PROMPT_BODY_LIMIT_BYTES],
    ["/internal/tasks/task-1/compact/abort", BACKEND_PROMPT_BODY_LIMIT_BYTES],
    ["/internal/tasks/task-1/unrevert", BACKEND_PROMPT_BODY_LIMIT_BYTES],
    ["/internal/bots/bot-1/routines/routine-1", 64 * 1024],
  ]) {
    const response = await exchange(`${base}${path}`, {
      ...headers, "content-length": String(limit + 1),
    }, (request) => request.flushHeaders());
    assert.equal(response.status, 413, path);
  }
  assert.equal(calls, 0);
});

test("chunked overflow cannot start a routine even though the route ignores its body", async (t) => {
  let calls = 0;
  const { base, headers } = await fixture(t, options({ isReady: () => true,
    runBotRoutine: () => { calls++; return {}; },
  }));
  const response = await exchange(`${base}/internal/bots/bot-1/routines/routine-1`, headers, (request) => {
    request.write(" ".repeat(64 * 1024));
    request.end("{}");
  });
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
  await assertHealthy(base, headers);
});

test("disconnect during an input-free action body does not invoke the owner", async (t) => {
  let calls = 0;
  const handler = () => { calls++; return {}; };
  const { server, base, headers } = await fixture(t, options({ isReady: () => true,
    abortTask: handler, abortCompactTaskAction: handler, unrevertTaskAction: handler, runBotRoutine: handler,
  }));
  for (const path of ["/internal/tasks/task-1/abort", "/internal/tasks/task-1/compact/abort",
    "/internal/tasks/task-1/unrevert", "/internal/bots/bot-1/routines/routine-1"]) {
    const incoming = once(server, "request");
    const request = httpRequest(`${base}${path}`, { method: "POST", headers });
    request.on("error", () => {});
    request.write("{");
    const [message] = await incoming;
    const closed = once(message, "close").catch((error) => {
      assert.equal(error.code, "ECONNRESET");
    });
    request.destroy();
    await closed;
    await nextTick();
    assert.equal(calls, 0, path);
  }
  await assertHealthy(base, headers);
});
