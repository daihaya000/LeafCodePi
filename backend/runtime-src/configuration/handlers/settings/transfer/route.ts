import {  ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse  } from "../../../http";
import { exportSettingsBackup, importSettingsBackup, resetStoredCredentials, type TransferScope } from "@/lib/pi/settings-transfer";
import { TransferRecoveryError, discardTransferRecoveryFile, listTransferRecoveries, restoreTransferRecoveryFile } from "@/lib/pi/transfer-recovery";
import { invalidateSettingsFileCache } from "@/lib/pi/web-settings";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { dataDir } from "@/lib/paths";
import { join } from "node:path";
import { rejectUnauthorizedTransfer, transferNoStore as noStore } from "../../../../lib/pi/transfer-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest) {
  const unauthorized = rejectUnauthorizedTransfer(req);
  if (unauthorized) return unauthorized;
  try {
    const result = await resetStoredCredentials();
    return NextResponse.json({ ok: true, ...result }, { headers: noStore });
  } catch (error) {
    if (error instanceof TransferRecoveryError) {
      return NextResponse.json({ error: error.message, recoveryPath: error.recoveryPath }, { status: 500, headers: noStore });
    }
    const status = (error as { status?: unknown }).status;
    return NextResponse.json(
      { error: status === 400 ? (error as Error).message : "認証の初期化に失敗しました" },
      { status: status === 400 ? 400 : 500, headers: noStore },
    );
  }
}

export async function GET(req: NextRequest) {
  const unauthorized = rejectUnauthorizedTransfer(req);
  if (unauthorized) return unauthorized;
  return NextResponse.json({ recoveries: listTransferRecoveries() }, { headers: noStore });
}

export async function POST(req: NextRequest) {
  // 未認証リクエストは JSON 本文を読み込む前に拒否する。
  const unauthorized = rejectUnauthorizedTransfer(req);
  if (unauthorized) return unauthorized;
  if (Number(req.headers.get("content-length")) > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "バックアップが大きすぎます" }, { status: 413, headers: noStore });
  }
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024) return NextResponse.json({ error: "バックアップが大きすぎます" }, { status: 413, headers: noStore });
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "リクエスト形式が不正です" }, { status: 400, headers: noStore });
    if (body.action === "recover" || body.action === "discard-recovery") {
      const id = body.recoveryId;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) {
        return NextResponse.json({ error: "保全ファイルIDが不正です" }, { status: 400, headers: noStore });
      }
      if (body.action === "discard-recovery") {
        discardTransferRecoveryFile(id);
        return NextResponse.json({ discarded: true }, { headers: noStore });
      }
      await restoreTransferRecoveryFile(join(dataDir(), "settings-transfer-recovery", `${id}.json`));
      invalidateSettingsFileCache();
      invalidateCachedUsage();
      return NextResponse.json({ recovered: true }, { headers: noStore });
    }
    const scope = body.action === "export" ? body.scope : (body.backup as { scope?: unknown } | null)?.scope;
    if (body.action === "export" && scope === "all") return NextResponse.json({ error: "設定と認証は個別にエクスポートしてください" }, { status: 400, headers: noStore });
    if (scope !== "settings" && scope !== "credentials" && scope !== "all") return NextResponse.json({ error: "範囲が不正です" }, { status: 400, headers: noStore });
    if (body.action === "export") {
      const backup = await exportSettingsBackup(scope as TransferScope);
      return NextResponse.json({ backup }, { headers: noStore });
    }
    if (body.action === "import") {
      const importedScope = await importSettingsBackup(body.backup);
      return NextResponse.json({ scope: importedScope }, { headers: noStore });
    }
    return NextResponse.json({ error: "操作が不正です" }, { status: 400, headers: noStore });
  } catch (error) {
    if (error instanceof TransferRecoveryError) {
      return NextResponse.json({ error: error.message, recoveryPath: error.recoveryPath }, { status: 500, headers: noStore });
    }
    const status = (error as { status?: unknown }).status;
    const expected = status === 400 || status === 409;
    return NextResponse.json({ error: expected ? (error as Error).message : "転送処理に失敗しました。変更が行われた場合は自動復旧を試みました" }, { status: status === 400 ? 400 : status === 409 ? 409 : 500, headers: noStore });
  }
}
