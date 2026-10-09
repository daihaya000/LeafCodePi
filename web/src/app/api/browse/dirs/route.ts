import { NextRequest } from "next/server";
import { relayJsonBusiness } from "@/lib/json-business-relay";
import { relayHostFolderSelection } from "@/lib/host-folder-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { return relayJsonBusiness(request, "browse/dirs"); }
export async function POST(request: NextRequest) { return relayHostFolderSelection(request); }
