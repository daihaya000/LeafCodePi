import type { NextRequest } from "next/server";
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return relayJsonBusiness(req, "codexbar/reset-credits");
}

export async function POST(req: NextRequest) {
  return relayJsonBusiness(req, "codexbar/reset-credits");
}
