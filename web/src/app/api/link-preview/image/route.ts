import { NextRequest } from "next/server";
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { return relayJsonBusiness(request, "link-preview/image"); }
