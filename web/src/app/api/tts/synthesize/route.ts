import { NextRequest } from "next/server";
import { relayTaskFileStream } from "@/lib/task-file-stream-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) { return relayTaskFileStream(request, "tts/synthesize"); }
