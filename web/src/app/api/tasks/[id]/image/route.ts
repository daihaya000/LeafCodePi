
import { relayTaskFileStream } from "@/lib/task-file-stream-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return relayTaskFileStream(request, `tasks/${encodeURIComponent((await context.params).id)}/image`);
}
export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
  return relayTaskFileStream(request, `tasks/${encodeURIComponent((await context.params).id)}/image`);
}
