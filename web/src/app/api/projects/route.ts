
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return relayJsonBusiness(req, "projects");
}

export async function POST(req: Request) {
  return relayJsonBusiness(req, "projects");
}

export async function PATCH(req: Request) {
  return relayJsonBusiness(req, "projects");
}

export async function DELETE(req: Request) {
  return relayJsonBusiness(req, "projects");
}
