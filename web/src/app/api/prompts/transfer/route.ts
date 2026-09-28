import { NextRequest, NextResponse } from "next/server";
import { exportPromptBackup, importPromptBackup } from "@/lib/pi/prompt-transfer";
import { rejectUnauthorizedTransfer, transferNoStore } from "@/lib/pi/transfer-access";
import { reloadLiveSessionsContext } from "@/lib/pi/harness";
import { TransferRecoveryError } from "@/lib/pi/transfer-recovery";
import { MAX_PROMPT_BACKUP_BYTES, type PromptFileName } from "@/lib/prompt-transfer-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Leave room for the action/selection envelope around a valid 20 MiB backup.
const MAX_REQUEST_BYTES = MAX_PROMPT_BACKUP_BYTES + 4 * 1024;

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
      let imported: PromptFileName[];
      let warning: string | undefined;
      try {
        imported = await importPromptBackup(input.backup, input.selected);
      } catch (error) {
        if (!(error instanceof TransferRecoveryError) || !error.applied) throw error;
        // Journal cleanup failed after all writes. Report the applied import and refresh the UI.
        imported = input.selected as PromptFileName[];
        warning = error.message;
      }
      const reload = await reloadLiveSessionsContext();
      return NextResponse.json({ imported, reload, warning }, { headers: transferNoStore });
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
