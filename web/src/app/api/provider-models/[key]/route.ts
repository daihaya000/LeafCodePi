import { NextResponse } from "next/server";
import { jsonError, setProviderOrModelEnabled } from "@/lib/pi/harness";
import { setProviderModelContextWindow } from "@/lib/provider-model-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await params;
    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
    }
    const body = raw as {
      enabled?: boolean;
      accountId?: string;
      modelIds?: unknown;
      contextWindow?: unknown;
    };
    if (body.contextWindow !== undefined) {
      if (
        typeof body.contextWindow !== "number" ||
        !Number.isSafeInteger(body.contextWindow) ||
        body.contextWindow < 4096 ||
        body.contextWindow > 1_000_000
      ) {
        return NextResponse.json({ error: "contextWindow は4096〜1000000の整数で指定してください" }, { status: 400 });
      }
      const separator = key.lastIndexOf("::");
      if (separator <= 0 || separator === key.length - 2) {
        return NextResponse.json({ error: "モデルキーが不正です" }, { status: 400 });
      }
      await setProviderModelContextWindow(
        decodeURIComponent(key.slice(0, separator)),
        decodeURIComponent(key.slice(separator + 2)),
        body.contextWindow,
        typeof body.accountId === "string" ? body.accountId : undefined,
      );
      return NextResponse.json({ ok: true });
    }
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
