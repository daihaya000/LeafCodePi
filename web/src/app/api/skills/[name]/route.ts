import type { NextRequest } from "next/server";
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  return relayJsonBusiness(req, `skills/${encodeURIComponent((await context.params).name)}`);
}
