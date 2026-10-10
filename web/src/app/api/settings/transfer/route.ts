
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function DELETE(request: Request) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/settings/transfer", { method: "DELETE" }), "settings/transfer");
}

export function GET(request: Request) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/settings/transfer", { method: "GET" }), "settings/transfer");
}

export function POST(request: Request) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/settings/transfer", { method: "POST" }), "settings/transfer");
}
