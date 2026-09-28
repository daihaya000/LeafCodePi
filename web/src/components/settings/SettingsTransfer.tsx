"use client";

import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { prepareServerSettingsImport, refreshServerSettings } from "@/lib/setting-sync";
import type { SettingsBackup, TransferScope } from "@/lib/pi/settings-transfer";

// 設定一式は「設定エクスポート」（ProfileSettings）が担い、ここはプロバイダー認証だけを出力する。
// インポートは旧版で出力した「設定のみ」「両方」のJSONも受け付ける。
const labels: Record<TransferScope, string> = {
  settings: "WebUI動作設定",
  credentials: "プロバイダー認証",
  all: "WebUI動作設定とプロバイダー認証",
};

type BusyAction = "export" | "import" | "recovery";

export function SettingsTransfer() {
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportCredentials() {
    if (!window.confirm("APIキー・OAuthトークン・cookie を平文JSONで保存します。安全な場所に保管しますか？")) return;
    setBusy("export");
    setError(null);
    setMessage(null);
    try {
      const result = await sendJson<{ backup: SettingsBackup }>("/api/settings/transfer", { action: "export", scope: "credentials" });
      const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `leafcode-pi-credentials-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`${labels.credentials}をエクスポートしました`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "エクスポートに失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function importBackup(file: File) {
    setBusy("import");
    setError(null);
    setMessage(null);
    setRecoveryId(null);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("バックアップは20MB以下にしてください");
      const backup = JSON.parse(await file.text()) as SettingsBackup;
      if (backup?.format !== "leafcode-pi-settings" || backup.version !== 1 || !Object.hasOwn(labels, backup.scope)) {
        throw new Error("対応していないバックアップ形式です");
      }
      if (!window.confirm(`${labels[backup.scope]}を取り込みます。重複する項目は上書きし、他は残します。続行しますか？`)) return;
      const acceptImported = await prepareServerSettingsImport(Object.keys(backup.settings ?? {}));
      await sendJson("/api/settings/transfer", { action: "import", backup });
      acceptImported();
      await refreshServerSettings();
      setMessage(`${labels[backup.scope]}をインポートしました。実行中セッションや認証キャッシュへの反映にはLeafCodePiを再起動してください。`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "インポートに失敗しました";
      setError(detail);
      setRecoveryId(detail.startsWith("設定の自動復旧に失敗しました")
        ? detail.match(/settings-transfer-recovery[\\/]([0-9a-f-]{36})\.json/)?.[1] ?? null
        : null);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
      setBusy(null);
    }
  }

  async function checkRecoveries() {
    setBusy("recovery");
    setError(null);
    try {
      const result = await getJson<{ recoveries: string[] }>("/api/settings/transfer", undefined, { coalesce: false });
      setRecoveries(result.recoveries);
      if (!result.recoveries.length) setMessage("保全ファイルはありません");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保全ファイルの確認に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function recoverBackup(id: string) {
    if (!window.confirm("書き込み障害を解消しましたか？異常終了で残ったファイルは適用済みの設定を取り消す可能性もあります。保全ファイルからインポート前の状態に戻しますか？")) return;
    setBusy("recovery");
    setError(null);
    try {
      await sendJson("/api/settings/transfer", { action: "recover", recoveryId: id });
      await refreshServerSettings();
      setRecoveryId(null);
      setRecoveries((current) => current.filter((item) => item !== id));
      setMessage("保全ファイルから復旧しました。LeafCodePiを再起動してください。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "復旧に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function discardRecovery(id: string) {
    if (!window.confirm("復旧は不要で、現在の設定が正しいことを確認しましたか？保全ファイルを削除すると復旧できません。")) return;
    setBusy("recovery");
    setError(null);
    try {
      await sendJson("/api/settings/transfer", { action: "discard-recovery", recoveryId: id });
      setRecoveryId(null);
      setRecoveries((current) => current.filter((item) => item !== id));
      setMessage("保全ファイルを削除しました");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保全ファイルの削除に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">認証エクスポート</h3>
      <p className="mt-1 text-xs leading-5 text-muted">
        プロバイダーのAuth/APIキー/cookieだけをJSONで転送します。インポートは重複する認証だけを上書きし、他は残します。ブラウザ内のcookie・環境変数・OS資格情報ストアは含みません。
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button className="w-full" variant="secondary" busy={busy === "export"} disabled={disabled} onClick={() => void exportCredentials()}>
          <Download className="h-4 w-4" />エクスポート
        </Button>
        <label className={cx("inline-flex h-10 w-full cursor-pointer items-center whitespace-nowrap justify-center gap-2 rounded-lg border border-border bg-surface-2 px-3.5 text-sm text-text transition-colors hover:bg-surface-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent", disabled && "pointer-events-none opacity-40")}>
          <Upload className="h-4 w-4" />インポート
          <input ref={fileRef} type="file" accept=".json,application/json" disabled={disabled} aria-label="認証JSONを選択" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBackup(file); }} />
        </label>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted">ローカル接続またはWebUIアクセスゲート有効時のみ利用できます。JSONは平文のため、共有・クラウド同期に注意してください。インポート前に元のファイルを一時保全し、失敗時は自動復旧します。復旧不能・異常終了時に残る保全ファイルも秘密情報として扱ってください。</p>
      {message && <p role="status" className="mt-2 text-xs text-success">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      {recoveryId && <button type="button" disabled={disabled} onClick={() => void recoverBackup(recoveryId)} className="mt-3 min-h-11 rounded-lg border border-border bg-surface-2 px-4 text-sm text-text focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">保全ファイルから復旧</button>}
      <div className="mt-3">
        <button type="button" disabled={disabled} onClick={() => void checkRecoveries()} className="min-h-11 text-sm text-accent hover:underline disabled:opacity-50">異常終了後の保全ファイルを確認</button>
        {recoveries.length > 0 && (
          <div className="mt-2 space-y-2 text-xs text-muted">
            <p>保全ファイル {recoveries.length} 件。復旧すると適用済みの変更も取り消す可能性があります。</p>
            {recoveries.map((id) => (
              <div key={id} className="flex flex-wrap items-center gap-2">
                <span className="break-all">{id}</span>
                {id !== recoveryId && <button type="button" disabled={disabled} onClick={() => void recoverBackup(id)} className="min-h-11 rounded-lg border border-border bg-surface-2 px-3 text-text disabled:opacity-50">復旧</button>}
                <button type="button" disabled={disabled} onClick={() => void discardRecovery(id)} className="min-h-11 rounded-lg border border-border bg-surface-2 px-3 text-text disabled:opacity-50">保全ファイルを削除</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
