import { createGatewayServer, createProductionGatewayServer } from "./server.mjs";
import { routes } from "./routes.mjs";

process.env.LEAFCODE_PI_PROCESS_ROLE = "next";
const port = Number(process.env.LEAFCODE_PI_PORT ?? process.env.PORT ?? "3010");
const host = process.env.LEAFCODE_PI_BIND_HOST ?? process.env.LEAFCODE_PI_HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid gateway port");
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--api-only")) throw new Error("Unknown gateway argument");
// API-only is explicit legacy/contract mode. The default production entry must have a build.
const server = args[0] === "--api-only" ? createGatewayServer(routes, { hostname: host })
  : await createProductionGatewayServer(routes, { hostname: host, staticRoot: process.env.LEAFCODE_PI_SPA_DIR });
server.listen(port, host, () => console.log(JSON.stringify({ type: "gateway_listening", port: server.address().port })));
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  server.close(); server.closeAllConnections();
  const deadline = setTimeout(() => process.exit(1), 3000); deadline.unref();
}
process.once("SIGTERM", stop); process.once("SIGINT", stop);
// CLI/Host IPC ownership: parent loss must not orphan a native ingress listener.
if (process.connected) process.once("disconnect", stop);
