import { NextResponse } from "next/server";
import { jsonError, setProviderOrModelEnabled } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await params;
    const body = (await req.json()) as {
      enabled?: boolean;
      accountId?: string;
      modelIds?: unknown;
    };
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled が必要です" }, { status: 400 });
    }
    if (
      body.modelIds !== undefined &&
      (!Array.isArray(body.modelIds) ||
        body.modelIds.some(
          (modelId) => typeof modelId !== "string" || !modelId.trim(),
        ))
    ) {
      return NextResponse.json({ error: "modelIds が不正です" }, { status: 400 });
    }
    await setProviderOrModelEnabled(
      decodeURIComponent(key),
      body.enabled,
      typeof body.accountId === "string" ? body.accountId : undefined,
      body.modelIds as string[] | undefined,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
