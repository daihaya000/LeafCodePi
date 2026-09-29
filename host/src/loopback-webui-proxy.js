import { createServer, request } from "node:http";

const upgradeSockets = new WeakMap();

/**
 * Expose the Tailscale-bound WebUI on this machine's loopback only, without
 * widening its network bind to LAN interfaces. The target is resolved for each
 * request so a Tailscale address change does not leave a stale proxy behind.
 */
export function createLoopbackWebUiProxy(getTarget) {
  const server = createServer((incoming, outgoing) => {
    const { host, port } = getTarget();
    const upstream = request({
      hostname: host,
      port,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.pipe(outgoing);
      // pipe() does not tear down the source when the destination goes away or
      // the source dies mid-stream; long-lived SSE responses would leak.
      response.on("error", () => outgoing.destroy());
      response.on("aborted", () => outgoing.destroy());
    });
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    upstream.on("error", () => {
      if (outgoing.destroyed) return;
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  });

  const sockets = new Set();
  upgradeSockets.set(server, sockets);
  server.on("upgrade", (incoming, client, head) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    const { host, port } = getTarget();
    const upstream = request({
      hostname: host,
      port,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      const headers = Object.entries(response.headers)
        .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`))
        .join("\r\n");
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
      client.on("error", () => remote.destroy());
      client.on("close", () => remote.destroy());
      remote.on("error", () => client.destroy());
      remote.on("close", () => client.destroy());
    });
    upstream.on("response", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.end();
  });

  return server;
}

export function listenLoopbackWebUiProxy(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function closeLoopbackWebUiProxy(server) {
  if (!server?.listening) return Promise.resolve();
  for (const socket of upgradeSockets.get(server) ?? []) socket.destroy();
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
