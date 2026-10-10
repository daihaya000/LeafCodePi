
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return relayJsonBusiness(req, "workflow-md");
}

export async function PATCH(req: Request) {
  return relayJsonBusiness(req, "workflow-md");
}
