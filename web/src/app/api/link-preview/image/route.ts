
import { relayTaskFileStream } from "@/lib/task-file-stream-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return relayTaskFileStream(request, "link-preview/image"); }
export async function HEAD(request: Request) { return relayTaskFileStream(request, "link-preview/image"); }
