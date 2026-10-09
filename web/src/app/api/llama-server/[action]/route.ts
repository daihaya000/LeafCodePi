import { relayHostLlama } from "@/lib/host-llama-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ action: string }> }) { return relayHostLlama(request, (await params).action); }
export const POST = GET;
