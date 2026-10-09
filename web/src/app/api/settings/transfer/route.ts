import { NextRequest } from "next/server";
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function DELETE(request?: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/settings/transfer", { method: "DELETE" }), "settings/transfer");
}

export function GET(request?: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/settings/transfer", { method: "GET" }), "settings/transfer");
}

export function POST(request: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/settings/transfer", { method: "POST" }), "settings/transfer");
}
