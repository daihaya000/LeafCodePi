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

test("local-client Explorer endpoint requires an allowed origin and local header", async () => {
  let opened = null;
  const port = await freePort();
  const server = createLlamaControlServer({
    controlPort: port,
    isLocalClientOrigin: (origin) => origin === "http://100.64.1.2:3010",
    onOpenExplorer: (path) => {
      opened = path;
      return { ok: true };
    },
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async () => ({ ok: true }),
    onLlamaServerStop: () => {},
  });
  await listenControlServer(server, port);
  try {
    const headers = {
      host: `127.0.0.1:${port}`,
      origin: "http://100.64.1.2:3010",
      "x-leafcode-pi-local-client": "1",
    };
    const capabilities = await fetch(`http://127.0.0.1:${port}/local-client/capabilities`, { headers });
    assert.equal(capabilities.status, 200);
    assert.deepEqual(await capabilities.json(), { ok: true, explorer: true });
    assert.equal(capabilities.headers.get("access-control-allow-origin"), "http://100.64.1.2:3010");

    const explorer = await fetch(`http://127.0.0.1:${port}/local-client/explorer`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ path: "C:\\\\work\\\\project" }),
    });
    assert.equal(explorer.status, 200);
    assert.deepEqual(await explorer.json(), { ok: true });
    assert.equal(opened, "C:\\\\work\\\\project");

    const denied = await fetch(`http://127.0.0.1:${port}/local-client/explorer`, {
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        origin: "http://remote.example",
        "x-leafcode-pi-local-client": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "C:\\\\work\\\\other" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(opened, "C:\\\\work\\\\project");
  } finally {
    await closeControlServer(server);
  }
});

test("local-client Explorer endpoint rejects requests without the local header", async () => {
  const port = await freePort();
  const server = createLlamaControlServer({
    controlPort: port,
    isLocalClientOrigin: () => true,
    onOpenExplorer: () => ({ ok: true }),
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async () => ({ ok: true }),
    onLlamaServerStop: () => {},
  });
  await listenControlServer(server, port);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/local-client/capabilities`, {
      headers: {
        host: `127.0.0.1:${port}`,
        origin: "http://100.64.1.2:3010",
      },
    });
    assert.equal(response.status, 403);
  } finally {
    await closeControlServer(server);
  }
});

test("POST /llama-server/start forwards empty effort and POSIX launch settings", async () => {
  let received = null;
  const port = await freePort();
  const server = createLlamaControlServer({
    controlPort: port,
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async (config) => {
      received = config;
      return { ok: true };
    },
    onLlamaServerStop: () => {},
  });
  await listenControlServer(server, port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/llama-server/start`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({
        effort: "",
        specType: "draft-mtp",
        cacheTypeK: "q8_0",
        cacheTypeV: "f16",
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(received, {
      effort: "",
      contextLength: undefined,
      parallel: undefined,
      llamaServerBin: undefined,
      modelDir: undefined,
      modelFile: undefined,
      llamaServerHost: undefined,
      specType: "draft-mtp",
      cacheTypeK: "q8_0",
      cacheTypeV: "f16",
    });
  } finally {
    await closeControlServer(server);
  }
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
  await new Promise((r) => setTimeout(r, 180));
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
  await new Promise((r) => setTimeout(r, 180));
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

test("POST /llama-server/start returns a controlled error when launch fails", async () => {
  const port = await freePort();
  const server = createLlamaControlServer({
    controlPort: port,
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async () => {
      throw new Error("spawn llama-server ENOENT");
    },
    onLlamaServerStop: () => {},
  });
  await listenControlServer(server, port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/llama-server/start`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: "spawn llama-server ENOENT" });

    const status = await fetch(`http://127.0.0.1:${port}/llama-server/status`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { ok: true });
  } finally {
    await closeControlServer(server);
  }
});
