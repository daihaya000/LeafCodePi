import { NextResponse } from "next/server";
import { invalidateHealthCache, jsonError, setProviderOrModelEnabled } from "@/lib/pi/harness";
import {
  setProviderModelContextWindow,
  setProviderModelDefaultThinkingLevel,
} from "@/lib/provider-model-state";
import { isThinkingLevel } from "@/lib/thinking-levels";

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
      defaultThinkingLevel?: unknown;
    };
    const separator = key.lastIndexOf("::");
    if (body.contextWindow !== undefined || body.defaultThinkingLevel !== undefined) {
      if (separator <= 0 || separator === key.length - 2) {
        return NextResponse.json({ error: "モデルキーが不正です" }, { status: 400 });
      }
      const providerID = decodeURIComponent(key.slice(0, separator));
      const modelID = decodeURIComponent(key.slice(separator + 2));
      const accountId = typeof body.accountId === "string" ? body.accountId : undefined;
      if (body.contextWindow !== undefined) {
        if (
          typeof body.contextWindow !== "number" ||
          !Number.isSafeInteger(body.contextWindow) ||
          body.contextWindow < 4096 ||
          body.contextWindow > 1_000_000
        ) {
          return NextResponse.json({ error: "contextWindow は4096〜1000000の整数で指定してください" }, { status: 400 });
        }
        await setProviderModelContextWindow(
          providerID,
          modelID,
          body.contextWindow,
          accountId,
        );
      } else {
        const level = body.defaultThinkingLevel;
        if (level !== null && !isThinkingLevel(level)) {
          return NextResponse.json({ error: "defaultThinkingLevel が不正です" }, { status: 400 });
        }
        await setProviderModelDefaultThinkingLevel(
          providerID,
          modelID,
          level === null ? null : level,
          accountId,
        );
      }
      invalidateHealthCache();
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
