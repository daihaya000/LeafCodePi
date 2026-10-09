import { NextRequest } from "next/server";
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `tasks/${encodeURIComponent((await context.params).id)}/unrevert`);
}
