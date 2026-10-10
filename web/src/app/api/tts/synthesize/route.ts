
import { relayTaskFileStream } from "@/lib/task-file-stream-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return relayTaskFileStream(request, "tts/synthesize"); }
