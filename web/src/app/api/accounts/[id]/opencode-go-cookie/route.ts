import type { NextRequest } from "next/server";
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `accounts/${encodeURIComponent((await context.params).id)}/opencode-go-cookie`);
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `accounts/${encodeURIComponent((await context.params).id)}/opencode-go-cookie`);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return relayJsonBusiness(req, `accounts/${encodeURIComponent((await context.params).id)}/opencode-go-cookie`);
}
