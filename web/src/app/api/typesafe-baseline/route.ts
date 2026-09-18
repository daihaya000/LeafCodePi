import { NextRequest, NextResponse } from "next/server";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import {
  readTypesafeCreditBaseline,
  writeTypesafeCreditBaseline,
} from "@/lib/codexbar/providers/typesafe";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BASELINE_USD = 1_000_000;

export function GET() {
  return NextResponse.json({ baselineUsd: readTypesafeCreditBaseline() });
}

/** 実残高から使用率を導出するためのTypeSafe基準残高（USD）を保存する。 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const baselineUsd = body?.baselineUsd;
    if (
      typeof baselineUsd !== "number" ||
      !Number.isFinite(baselineUsd) ||
      baselineUsd <= 0 ||
      baselineUsd > MAX_BASELINE_USD
    ) {
      return NextResponse.json(
        { error: `baselineUsd は 0 より大きく ${MAX_BASELINE_USD} 以下の数値で指定してください` },
        { status: 400 },
      );
    }
    writeTypesafeCreditBaseline(baselineUsd);
    invalidateCachedUsage();
    clearProviderCache("default:typesafe");
    return NextResponse.json({ ok: true, baselineUsd });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** 基準残高を解除し、残高額のみの表示へ戻す。 */
export function DELETE() {
  writeTypesafeCreditBaseline(null);
  invalidateCachedUsage();
  clearProviderCache("default:typesafe");
  return NextResponse.json({ ok: true, baselineUsd: null });
}
