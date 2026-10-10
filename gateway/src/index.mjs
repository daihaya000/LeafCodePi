import { createGatewayServer } from "./server.mjs";
import { routes } from "./routes.mjs";

process.env.LEAFCODE_PI_PROCESS_ROLE = "next";
const port = Number(process.env.LEAFCODE_PI_PORT ?? process.env.PORT ?? "3010");
const host = process.env.LEAFCODE_PI_BIND_HOST ?? process.env.LEAFCODE_PI_HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid gateway port");
const server = createGatewayServer(routes, { hostname: host });
server.listen(port, host, () => console.log(JSON.stringify({ type: "gateway_listening", port: server.address().port })));
function stop() {
  server.close(); server.closeAllConnections();
  const deadline = setTimeout(() => process.exit(1), 3000); deadline.unref();
}
process.once("SIGTERM", stop); process.once("SIGINT", stop);
