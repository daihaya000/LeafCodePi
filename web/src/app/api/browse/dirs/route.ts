
import { relayJsonBusiness } from "@/lib/json-business-relay";
import { relayHostFolderSelection } from "@/lib/host-folder-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return relayJsonBusiness(request, "browse/dirs"); }
export async function POST(request: Request) { return relayHostFolderSelection(request); }
