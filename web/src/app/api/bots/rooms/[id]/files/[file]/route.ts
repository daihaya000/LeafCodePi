
import { relayTaskFileStream } from "@/lib/task-file-stream-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; file: string }> }) {
  return relayTaskFileStream(request, `bots/rooms/${encodeURIComponent((await context.params).id)}/files/${encodeURIComponent((await context.params).file)}`);
}
export async function HEAD(request: Request, context: { params: Promise<{ id: string; file: string }> }) {
  return relayTaskFileStream(request, `bots/rooms/${encodeURIComponent((await context.params).id)}/files/${encodeURIComponent((await context.params).file)}`);
}
