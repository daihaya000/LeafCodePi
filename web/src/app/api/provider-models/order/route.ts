import { NextResponse } from "next/server";
import { jsonError, saveProviderModelsOrder } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      providerOrder?: string[];
      modelOrder?: Record<string, string[]>;
      accountModelOrder?: Record<string, Record<string, string[]>>;
    };
    await saveProviderModelsOrder({
      providerOrder: body.providerOrder,
      modelOrder: body.modelOrder,
      accountModelOrder: body.accountModelOrder,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
