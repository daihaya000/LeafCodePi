
import { relayJsonBusiness } from "@/lib/json-business-relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context) {
  return relayJsonBusiness(request,`tasks/${encodeURIComponent((await context.params).id)}/goal-loop`);
}
export async function POST(request:Request,context:Context) {
  return relayJsonBusiness(request,`tasks/${encodeURIComponent((await context.params).id)}/goal-loop`);
}
export async function PATCH(request:Request,context:Context) {
  return relayJsonBusiness(request,`tasks/${encodeURIComponent((await context.params).id)}/goal-loop`);
}
