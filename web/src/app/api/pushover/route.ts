import { NextRequest } from "next/server";
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request?: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/pushover", { method: "GET" }), "pushover");
}

export function PUT(request: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/pushover", { method: "PUT" }), "pushover");
}

export function POST(request: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/pushover", { method: "POST" }), "pushover");
}
