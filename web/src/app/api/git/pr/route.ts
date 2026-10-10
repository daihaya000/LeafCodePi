
import { relayJsonBusiness } from "@/lib/json-business-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return relayJsonBusiness(req, "git/pr");
}

export async function POST(req: Request) {
  return relayJsonBusiness(req, "git/pr");
}
