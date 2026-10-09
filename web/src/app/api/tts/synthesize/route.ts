import { NextRequest } from "next/server";
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) { return relayJsonBusiness(request, "tts/synthesize"); }
