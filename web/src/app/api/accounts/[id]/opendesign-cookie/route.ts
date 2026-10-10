import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `accounts/${encodeURIComponent((await context.params).id)}/opendesign-cookie`);
}
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `accounts/${encodeURIComponent((await context.params).id)}/opendesign-cookie`);
}
