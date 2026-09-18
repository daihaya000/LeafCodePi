import { NextRequest, NextResponse } from "next/server";
import {
  deleteTypesafeCookieFile,
  hasTypesafeCookieFile,
  saveTypesafeCookieFile,
} from "@/lib/codexbar/browser-cookies";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** cookie本文は返さず、保存済みかだけを返す。 */
export function GET() {
  return NextResponse.json({ configured: hasTypesafeCookieFile() });
}

/** TypeSafe Console cookie本文を保存する。 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.cookies !== "string") {
      return NextResponse.json({ error: "cookies は文字列で指定してください" }, { status: 400 });
    }
    saveTypesafeCookieFile(body.cookies);
    invalidateCachedUsage();
    clearProviderCache("default:typesafe");
    return NextResponse.json({ ok: true, configured: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** UIから保存した TypeSafe Console cookie を削除する。 */
export function DELETE() {
  deleteTypesafeCookieFile();
  invalidateCachedUsage();
  clearProviderCache("default:typesafe");
  return NextResponse.json({ ok: true, configured: false });
}
