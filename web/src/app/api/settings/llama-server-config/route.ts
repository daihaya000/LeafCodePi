
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/settings/llama-server-config", { method: "GET" }), "settings/llama-server-config");
}

export function PUT(request: Request) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/settings/llama-server-config", { method: "PUT" }), "settings/llama-server-config");
}
