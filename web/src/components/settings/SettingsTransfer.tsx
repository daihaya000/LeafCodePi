"use client";

import { useState } from "react";
import { History, RotateCcw, Search, Trash2 } from "lucide-react";
import { Button, cx } from "@/components/ui";
import { SettingsDisclosure, TransferActions } from "@/components/settings/TransferControls";
import { getJson, sendJson } from "@/lib/client";
import { prepareServerSettingsImport, refreshServerSettings } from "@/lib/setting-sync";
import type { SettingsBackup, TransferScope } from "@/lib/pi/settings-transfer";

// 設定エクスポートは構成のみ、ここはPi/プロバイダー/アカウントの認証だけを出力する。
// インポートは旧版で出力した「設定のみ」「両方」のJSONも受け付ける。
const labels: Record<TransferScope, string> = {
  settings: "WebUI動作設定",
  credentials: "認証情報",
  all: "WebUI動作設定と認証情報",
};

type BusyAction = "export" | "import" | "reset" | "check" | `recover:${string}` | `discard:${string}`;

export function SettingsTransfer() {
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<string[]>([]);

  async function exportCredentials() {
    if (!window.confirm("APIキー・OAuthトークン・接続トークン・cookieを平文JSONで保存します。安全な場所に保管しますか？")) return;
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
      setBusy(null);
    }
  }

  async function checkRecoveries() {
    setBusy("check");
    setError(null);
    setMessage(null);
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
    setBusy(`recover:${id}`);
    setError(null);
    setMessage(null);
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
    setBusy(`discard:${id}`);
    setError(null);
    setMessage(null);
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

  async function resetCredentials() {
    if (!window.confirm("保存済みのプロバイダー認証とアカウント接続トークンを初期化します。旧認証はバックアップへ退避し、このPCのログイン状態は未ログインへ戻ります。完了後にLeafCodePiを再起動してください。")) return;
    setBusy("reset");
    setError(null);
    setMessage(null);
    setRecoveryId(null);
    try {
      const result = await sendJson<{ backupPath: string; accountCount: number; warning?: string }>("/api/settings/transfer", undefined, "DELETE");
      setMessage(`旧認証を${result.backupPath}へ退避し、プロバイダー認証とアカウント接続認証を初期化しました。LeafCodePiを再起動してください`);
      if (result.warning) setError(result.warning);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "認証の初期化に失敗しました";
      setError(detail);
      setRecoveryId(detail.startsWith("設定の自動復旧に失敗しました")
        ? detail.match(/settings-transfer-recovery[\\/]([0-9a-f-]{36})\.json/)?.[1] ?? null
        : null);
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">認証エクスポート</h3>
      <p className="mt-1 text-xs leading-5 text-muted">
        Pi既定認証・プロバイダー認証・アカウント認証（接続トークンを含む）・cookieだけをJSONで転送します。インポートは重複する認証だけを上書きし、他は残します。設定エクスポートは構成専用です。WebUIアクセス認証・ブラウザ内cookie・環境変数・OS資格情報ストアは含みません。
      </p>
      <div className="mt-3 space-y-4">
        <TransferActions
          accept=".json,application/json"
          fileLabel="認証JSONを選択"
          disabled={disabled}
          exportBusy={busy === "export"}
          importBusy={busy === "import"}
          onExport={() => void exportCredentials()}
          onFile={(file) => void importBackup(file)}
        />
        <p className="text-xs leading-5 text-muted">ローカル接続またはWebUIアクセスゲート有効時のみ利用できます。JSONは平文のため、共有・クラウド同期に注意してください。</p>
        <SettingsDisclosure title="保全ファイル">
          <p className="text-xs leading-5 text-muted">インポート前に元のファイルを一時保全し、失敗時は自動復旧します。復旧不能・異常終了時に残る保全ファイルも秘密情報として扱ってください。</p>
          <Button className="w-full" variant="secondary" busy={busy === "check"} disabled={disabled} onClick={() => void checkRecoveries()}>
            <Search className="h-4 w-4" />異常終了後の保全ファイルを確認
          </Button>
          {recoveries.length > 0 && (
            <>
              <p className="text-xs leading-5 text-muted">保全ファイル {recoveries.length} 件。復旧すると適用済みの変更も取り消す可能性があります。</p>
              <ul className="space-y-2">
                {recoveries.map((id) => (
                  <li key={id} className="space-y-2">
                    <p className="break-all font-mono text-xs text-muted">{id}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {id !== recoveryId && (
                        <Button className="w-full" variant="secondary" busy={busy === `recover:${id}`} disabled={disabled} onClick={() => void recoverBackup(id)}>
                          <History className="h-4 w-4" />復旧
                        </Button>
                      )}
                      <Button className={cx("w-full", id === recoveryId && "col-span-2")} variant="danger" busy={busy === `discard:${id}`} disabled={disabled} onClick={() => void discardRecovery(id)}>
                        <Trash2 className="h-4 w-4" />削除
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </SettingsDisclosure>
        <SettingsDisclosure title="認証の初期化">
          <p className="text-xs leading-5 text-muted">
            保存済みのプロバイダー認証（auth.json・cookie・アカウント/接続認証）をバックアップへ退避してから削除します。退避したJSONはこのカードのインポートで戻せます。アカウント一覧とWebUI動作設定は残り、WebUIアクセス認証・OS資格情報ストア・ブラウザ内のcookieは変更しません。
          </p>
          <Button className="w-full" variant="danger" busy={busy === "reset"} disabled={disabled} onClick={() => void resetCredentials()}>
            <RotateCcw className="h-4 w-4" />初期化
          </Button>
        </SettingsDisclosure>
      </div>
      {message && <p role="status" className="mt-2 text-xs text-success">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      {recoveryId && (
        <Button className="mt-2 w-full" variant="secondary" busy={busy === `recover:${recoveryId}`} disabled={disabled} onClick={() => void recoverBackup(recoveryId)}>
          <History className="h-4 w-4" />保全ファイルから復旧
        </Button>
      )}
    </div>
  );
}
