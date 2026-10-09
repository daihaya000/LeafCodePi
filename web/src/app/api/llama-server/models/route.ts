import { relayHostLlama } from "@/lib/host-llama-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return relayHostLlama(request, "models"); }
