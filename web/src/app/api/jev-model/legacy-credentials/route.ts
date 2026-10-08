import { NextRequest } from "next/server";
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request?: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/jev-model/legacy-credentials", { method: "GET" }), "jev-model/legacy-credentials");
}

export function DELETE(request?: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/jev-model/legacy-credentials", { method: "DELETE" }), "jev-model/legacy-credentials");
}
