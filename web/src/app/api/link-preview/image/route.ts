import { NextRequest } from "next/server";
import { relayTaskFileStream } from "@/lib/task-file-stream-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { return relayTaskFileStream(request, "link-preview/image"); }
export async function HEAD(request: NextRequest) { return relayTaskFileStream(request, "link-preview/image"); }
