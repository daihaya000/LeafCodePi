
import { relayConfiguration } from "@/lib/configuration-relay";
import { relayTaskFileStream } from "@/lib/task-file-stream-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return relayTaskFileStream(request, "profile"); }
export function HEAD(request: Request) { return relayTaskFileStream(request, "profile"); }
export function POST(request: Request) { return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "POST" }), "profile"); }
export function PATCH(request: Request) { return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "PATCH" }), "profile"); }
export function PUT(request: Request) { return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "PUT" }), "profile"); }
export function DELETE(request: Request) { return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "DELETE" }), "profile"); }
