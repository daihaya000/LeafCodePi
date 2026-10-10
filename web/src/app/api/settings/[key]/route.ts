
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  return relayConfiguration(request, `settings/${encodeURIComponent(key)}`);
}

export async function PUT(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  return relayConfiguration(request, `settings/${encodeURIComponent(key)}`);
}
