import { NextRequest } from "next/server";
import { relayConfiguration } from "@/lib/configuration-relay";
import { relayTaskFileStream } from "@/lib/task-file-stream-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) { return relayTaskFileStream(request, "profile"); }
export function HEAD(request: NextRequest) { return relayTaskFileStream(request, "profile"); }
export function POST(request: NextRequest) { return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "POST" }), "profile"); }
export function PATCH(request: NextRequest) { return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "PATCH" }), "profile"); }
export function PUT(request: NextRequest) { return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "PUT" }), "profile"); }
export function DELETE(request: NextRequest) { return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "DELETE" }), "profile"); }
