import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { createLlamaControlServer, closeControlServer } from "./llama-control-server.js";
test("activity endpoint uses the existing loopback and origin guards", async (t) => {
  let count = 0;
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const server = createLlamaControlServer({ controlPort: port, onUserActivity: () => count++ });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => closeControlServer(server));
  const url = `http://127.0.0.1:${server.address().port}/host/activity`;
  const headers = { host: "localhost" };
  assert.equal((await fetch(url, { method: "POST", headers })).status, 204);
  assert.equal(count, 1);
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://evil.invalid" } })).status, 403);
  const rejected = await new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write("POST /host/activity HTTP/1.1\r\nHost: evil.invalid\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    let output = "";
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("end", () => resolve(output));
  });
  assert.match(rejected, /^HTTP\/1\.1 403/);
  assert.equal(count, 1);
});
