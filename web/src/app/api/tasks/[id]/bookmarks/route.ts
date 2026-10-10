
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `tasks/${encodeURIComponent((await context.params).id)}/bookmarks`);
}

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `tasks/${encodeURIComponent((await context.params).id)}/bookmarks`);
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `tasks/${encodeURIComponent((await context.params).id)}/bookmarks`);
}
