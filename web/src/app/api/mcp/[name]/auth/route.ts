import { NextRequest } from "next/server";
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ name: string }> }) { return relayJsonBusiness(request, `mcp/${encodeURIComponent((await context.params).name)}/auth`); }
export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) { return relayJsonBusiness(request, `mcp/${encodeURIComponent((await context.params).name)}/auth`); }
export async function DELETE(request: NextRequest, context: { params: Promise<{ name: string }> }) { return relayJsonBusiness(request, `mcp/${encodeURIComponent((await context.params).name)}/auth`); }
