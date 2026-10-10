
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return relayJsonBusiness(request, "unread"); }
export async function PUT(request: Request) { return relayJsonBusiness(request, "unread"); }
