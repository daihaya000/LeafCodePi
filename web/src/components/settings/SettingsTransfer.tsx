"use client";

import { useRef, useState } from "react";
import { sendJson } from "@/lib/client";
import { prepareServerSettingsImport, refreshServerSettings } from "@/lib/setting-sync";
import type { SettingsBackup, TransferScope } from "@/lib/pi/settings-transfer";

const labels: Record<TransferScope, string> = {
  settings: "設定のみ",
  credentials: "プロバイダー認証のみ",
  all: "設定と認証の両方",
};

export function SettingsTransfer() {
  const [scope, setScope] = useState<TransferScope>("settings");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportBackup() {
    if (scope !== "settings" && !window.confirm("APIキー・OAuthトークン・cookie を平文JSONで保存します。安全な場所に保管しますか？")) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await sendJson<{ backup: SettingsBackup }>("/api/settings/transfer", { action: "export", scope });
      const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `leafcode-pi-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`${labels[scope]}をエクスポートしました`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "エクスポートに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function importBackup(file: File) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("バックアップは20MB以下にしてください");
      const backup = JSON.parse(await file.text()) as SettingsBackup;
      if (backup?.format !== "leafcode-pi-settings" || backup.version !== 1 || !Object.hasOwn(labels, backup.scope)) {
        throw new Error("対応していないバックアップ形式です");
      }
      if (!window.confirm(`${labels[backup.scope]}を取り込みます。重複する設定・認証は上書きし、他の設定は残します。続行しますか？`)) return;
      const acceptImported = await prepareServerSettingsImport(Object.keys(backup.settings ?? {}));
      await sendJson("/api/settings/transfer", { action: "import", backup });
      acceptImported();
      await refreshServerSettings();
      setMessage(`${labels[backup.scope]}をインポートしました。実行中セッションや認証キャッシュへの反映にはLeafCodePiを再起動してください。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "インポートに失敗しました");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">設定・認証の部分転送</h3>
      <p className="mt-1 text-xs text-muted">設定プロファイルとは別に、WebUIの保存済み動作設定やプロバイダーのAuth/APIキー/cookieだけを選んで転送します。プロンプトファイル・MCP・エージェント定義・ブラウザ内のcookie・環境変数・OS資格情報ストアは対象外です。</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-muted">エクスポート範囲</span>
          <select aria-label="エクスポート範囲" value={scope} onChange={(event) => setScope(event.target.value as TransferScope)} disabled={busy} className="min-h-11 rounded-lg border border-border bg-surface px-3 text-text focus-visible:outline-2 focus-visible:outline-accent">
            {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => void exportBackup()} className="min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">エクスポート</button>
        <label className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-border bg-surface-2 px-4 text-sm font-medium text-text has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:disabled]:opacity-50">
          インポート
          <input ref={fileRef} type="file" accept=".json,application/json" disabled={busy} aria-label="バックアップJSONを選択" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBackup(file); }} />
        </label>
      </div>
      <p className="mt-3 text-xs text-muted">部分転送はローカル接続またはWebUIアクセスゲート有効時のみ。認証バックアップは平文のため、共有・クラウド同期に注意してください。インポートは指定された項目だけを上書きします。</p>
      {message && <p role="status" className="mt-3 text-sm text-muted">{message}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </div>
  );
}
