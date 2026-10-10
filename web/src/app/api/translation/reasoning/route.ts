
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return relayJsonBusiness(request, "translation/reasoning"); }
