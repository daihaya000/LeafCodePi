import { NextRequest, NextResponse } from "next/server";
import { exportPromptBackup, importPromptBackup } from "@/lib/pi/prompt-transfer";
import { rejectUnauthorizedTransfer, transferNoStore } from "@/lib/pi/transfer-access";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { TransferRecoveryError } from "@/lib/pi/transfer-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const unauthorized = rejectUnauthorizedTransfer(req);
  if (unauthorized) return unauthorized;
  if (Number(req.headers.get("content-length")) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "バックアップが大きすぎます" }, { status: 413, headers: transferNoStore });
  }
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "バックアップが大きすぎます" }, { status: 413, headers: transferNoStore });
    }
    let body: unknown;
    try { body = JSON.parse(text) as unknown; }
    catch { return NextResponse.json({ error: "リクエスト本文が不正です" }, { status: 400, headers: transferNoStore }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "リクエスト形式が不正です" }, { status: 400, headers: transferNoStore });
    }
    const input = body as Record<string, unknown>;
    if (input.action === "export") {
      return NextResponse.json({ backup: exportPromptBackup() }, { headers: transferNoStore });
    }
    if (input.action === "import") {
      const imported = await importPromptBackup(input.backup, input.selected);
      const reload = await reloadLiveSessionsContext();
      return NextResponse.json({ imported, reload }, { headers: transferNoStore });
    }
    return NextResponse.json({ error: "操作が不正です" }, { status: 400, headers: transferNoStore });
  } catch (error) {
    if (error instanceof TransferRecoveryError) {
      return NextResponse.json({ error: error.message }, { status: 500, headers: transferNoStore });
    }
    const status = (error as { status?: unknown }).status;
    const expected = status === 400 || status === 409 || status === 413;
    return NextResponse.json({ error: expected ? (error as Error).message : "プロンプトの転送に失敗しました。書き込みがあった場合は自動復旧を試みました" },
      { status: expected ? status as number : 500, headers: transferNoStore });
  }
}
