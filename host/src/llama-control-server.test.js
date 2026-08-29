import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  createLlamaControlServer,
  closeControlServer,
  listenControlServer,
  isLoopbackHostHeader,
} from "./llama-control-server.js";

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test("isLoopbackHostHeader accepts loopback with port", () => {
  assert.equal(isLoopbackHostHeader("127.0.0.1:18775", 18775), true);
  assert.equal(isLoopbackHostHeader("evil.example:18775", 18775), false);
});

test("POST /restart/webui returns 202 then invokes handler", async () => {
  let called = false;
  const port = await freePort();
  const server = createLlamaControlServer({
    controlPort: port,
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async () => ({ ok: true }),
    onLlamaServerStop: () => {},
    onRestartWebui: () => {
      called = true;
    },
  });
  await listenControlServer(server, port);
  const res = await fetch(`http://127.0.0.1:${port}/restart/webui`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}` },
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.target, "webui");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, true);
  await closeControlServer(server);
});

test("POST /restart/host returns 202 then invokes handler", async () => {
  let called = false;
  const port = await freePort();
  const server = createLlamaControlServer({
    controlPort: port,
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async () => ({ ok: true }),
    onLlamaServerStop: () => {},
    onRestartHost: () => {
      called = true;
    },
  });
  await listenControlServer(server, port);
  const res = await fetch(`http://127.0.0.1:${port}/restart/host`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}` },
  });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, true);
  await closeControlServer(server);
});

test("POST /restart/host without handler returns 501", async () => {
  const port = await freePort();
  const server = createLlamaControlServer({
    controlPort: port,
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async () => ({ ok: true }),
    onLlamaServerStop: () => {},
  });
  await listenControlServer(server, port);
  const res = await fetch(`http://127.0.0.1:${port}/restart/host`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}` },
  });
  assert.equal(res.status, 501);
  await closeControlServer(server);
});

test("GET and POST /webui/auth expose safe status and validate updates", async () => {
  let patch = null;
  const port = await freePort();
  const server = createLlamaControlServer({
    controlPort: port,
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async () => ({ ok: true }),
    onLlamaServerStop: () => {},
    onWebUiAuthRead: () => ({ enabled: true, remote: true, authRequired: true, tokenConfigured: true }),
    onWebUiAuthWrite: (next) => {
      patch = next;
      return { enabled: next.enabled ?? true, remote: true, authRequired: false, tokenConfigured: true };
    },
  });
  await listenControlServer(server, port);
  try {
    const get = await fetch(`http://127.0.0.1:${port}/webui/auth`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { enabled: true, remote: true, authRequired: true, tokenConfigured: true });

    const post = await fetch(`http://127.0.0.1:${port}/webui/auth`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "user-token-1234567890", enabled: false }),
    });
    assert.equal(post.status, 202);
    assert.deepEqual(patch, { token: "user-token-1234567890", enabled: false });
    assert.equal((await post.json()).ok, true);

    const invalid = await fetch(`http://127.0.0.1:${port}/webui/auth`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: "false" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await closeControlServer(server);
  }
});
