
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ name: string }> }) { return relayJsonBusiness(request, `mcp/${encodeURIComponent((await context.params).name)}/auth`); }
export async function POST(request: Request, context: { params: Promise<{ name: string }> }) { return relayJsonBusiness(request, `mcp/${encodeURIComponent((await context.params).name)}/auth`); }
export async function DELETE(request: Request, context: { params: Promise<{ name: string }> }) { return relayJsonBusiness(request, `mcp/${encodeURIComponent((await context.params).name)}/auth`); }
