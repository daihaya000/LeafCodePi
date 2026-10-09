import { relayHostLlama } from "@/lib/host-llama-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return relayHostLlama(request, "ensure-loaded"); }
