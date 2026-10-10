
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/cache-warming", { method: "GET" }), "cache-warming");
}

export function PATCH(request: Request) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/cache-warming", { method: "PATCH" }), "cache-warming");
}
