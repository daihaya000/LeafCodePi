import { NextRequest } from "next/server";
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request?: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/compaction-settings", { method: "GET" }), "compaction-settings");
}

export function PATCH(request: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/compaction-settings", { method: "PATCH" }), "compaction-settings");
}
