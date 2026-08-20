import { NextResponse } from "next/server";
import { jsonError, startProviderLogin } from "@/lib/pi/harness";
import type { AuthTypeDto } from "@/lib/pi/auth-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { type?: string };
    const authType = (body.type === "api_key" ? "api_key" : "oauth") as AuthTypeDto;
    const result = await startProviderLogin(id, authType);
    return NextResponse.json(result);
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
