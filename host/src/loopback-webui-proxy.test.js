import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import {
  closeLoopbackWebUiProxy,
  createLoopbackWebUiProxy,
  listenLoopbackWebUiProxy,
} from "./loopback-webui-proxy.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test("loopback proxy forwards requests and follows target changes", async () => {
  const first = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    res.writeHead(201, { "content-type": "text/plain", "x-origin": req.headers.host });
    res.end(`first:${req.url}:${body}`);
  });
  const second = createServer((_req, res) => res.end("second"));
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  let targetPort = firstPort;
  const proxy = createLoopbackWebUiProxy(() => ({ host: "127.0.0.1", port: targetPort }));
  await listenLoopbackWebUiProxy(proxy, 0);
  try {
    const port = proxy.address().port;
    assert.equal(proxy.address().address, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/task/a?x=1`, {
      method: "POST",
      body: "hello",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-origin"), `127.0.0.1:${port}`);
    assert.equal(await response.text(), "first:/task/a?x=1:hello");

    targetPort = secondPort;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "second");
  } finally {
    await closeLoopbackWebUiProxy(proxy);
    await close(first);
    await close(second);
  }
});

test("loopback proxy forwards WebSocket upgrade bytes", { timeout: 3000 }, async () => {
  const target = createServer();
  const targetSockets = new Set();
  target.on("upgrade", (_request, socket) => {
    targetSockets.add(socket);
    socket.on("close", () => targetSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const targetPort = await listen(target);
  const proxy = createLoopbackWebUiProxy(() => ({ host: "127.0.0.1", port: targetPort }));
  await listenLoopbackWebUiProxy(proxy, 0);
  const client = connect(proxy.address().port, "127.0.0.1");
  try {
    await once(client, "connect");
    client.write("GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    const [response] = await once(client, "data");
    assert.match(response.toString(), /^HTTP\/1\.1 101 Switching Protocols/);
    client.write("ping");
    const [echo] = await once(client, "data");
    assert.equal(echo.toString(), "ping");
  } finally {
    client.destroy();
    await closeLoopbackWebUiProxy(proxy);
    for (const socket of targetSockets) socket.destroy();
    await close(target);
  }
});
