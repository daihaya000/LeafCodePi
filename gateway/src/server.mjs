import { createServer } from "node:http";
import { createDispatcher } from "./router.mjs";
import { nodeHttpHandler } from "./http-adapter.mjs";

export function createGatewayServer(routes, { hostname } = {}) {
  const server = createServer(nodeHttpHandler(createDispatcher(routes), incoming => ({ hostname: hostname ?? server.address().address, port: incoming.socket.localPort, forwarded: true })));
  // Transport-only process. Keep the established client role until owner guards gain a new name.
  // No SDK/owner startup is imported or run by this server.
  server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  return server;
}
