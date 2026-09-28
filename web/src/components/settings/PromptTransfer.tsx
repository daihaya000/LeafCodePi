"use client";

import { useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui";
import { TransferActions } from "@/components/settings/TransferControls";
import { sendJson } from "@/lib/client";
import {
  MAX_PROMPT_BACKUP_BYTES, PROMPT_FILE_GROUPS, PROMPT_FILE_NAMES, type PromptBackup, type PromptFileName,
} from "@/lib/prompt-transfer-format";

type BusyAction = "export" | "load" | "import";

export function PromptTransfer({ onImported }: { onImported: (imported: PromptFileName[]) => void }) {
  const [backup, setBackup] = useState<PromptBackup | null>(null);
  const [selected, setSelected] = useState<PromptFileName[]>([]);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportBackup() {
    if (!window.confirm("プロンプトに個人情報や秘密情報が含まれる場合があります。安全な場所に保存しますか？")) return;
    setBusy("export");
    setError(null);
    setMessage(null);
    try {
      const result = await sendJson<{ backup: PromptBackup }>("/api/prompts/transfer", { action: "export" });
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `leafcode-pi-prompts-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("プロンプトをエクスポートしました");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "エクスポートに失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function loadBackup(file: File) {
    setBusy("load");
    setBackup(null);
    setSelected([]);
    setError(null);
    setMessage(null);
    try {
      if (file.size > MAX_PROMPT_BACKUP_BYTES) throw new Error("バックアップは20MB以下にしてください");
      const parsed = JSON.parse(await file.text()) as PromptBackup;
      if (parsed?.format !== "leafcode-pi-prompts" || parsed.version !== 1 ||
        !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
        throw new Error("対応していないプロンプトのバックアップ形式です");
      }
      const names = Object.keys(parsed.files);
      if (!names.length || names.some((name) => !PROMPT_FILE_NAMES.includes(name as PromptFileName) || typeof parsed.files[name as PromptFileName] !== "string")) {
        throw new Error("バックアップに有効なプロンプトファイルがありません");
      }
      setBackup(parsed);
      setSelected(names as PromptFileName[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "バックアップの読み込みに失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function importBackup() {
    if (!backup || !selected.length || busy) return;
    if (!window.confirm(`${selected.join("、")} を上書きします。選択していないファイルは変更しません。選択したファイルの編集中の未保存内容は破棄されます。続行しますか？`)) return;
    setBusy("import");
    setError(null);
    setMessage(null);
    try {
      const result = await sendJson<{ imported: PromptFileName[]; reload: { reloaded: number; deferred: number; failed: number; errors: string[] }; warning?: string }>(
        "/api/prompts/transfer", { action: "import", backup, selected },
      );
      onImported(result.imported);
      setBackup(null);
      setSelected([]);
      setMessage(`${result.imported.length}件のプロンプトをインポートしました。開いているセッションへの反映: ${result.reload.reloaded}件成功、${result.reload.deferred}件は処理後に反映、${result.reload.failed}件失敗。`);
      if (result.warning || result.reload.errors[0]) setError([result.warning, result.reload.errors[0]].filter(Boolean).join("\n"));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "インポートに失敗しました";
      if (detail.includes("保全ファイル:")) {
        // Rollback may have left some selected files changed. Refresh their editors before recovery.
        onImported(selected);
        setBackup(null);
        setSelected([]);
      }
      setError(detail);
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">プロンプトエクスポート</h3>
      <p className="mt-1 text-xs leading-5 text-muted">この画面の7つのグローバルMarkdownファイルだけを転送します。インポートは選んだファイルだけを上書きします。認証・送信プロンプトのプリセットは対象外です。バックアップには個人情報や秘密情報が含まれ得ます。</p>
      <div className="mt-3 space-y-4">
        <TransferActions
          className="max-w-md"
          accept=".json,application/json"
          fileLabel="プロンプトのバックアップJSONを選択"
          disabled={disabled}
          exportBusy={busy === "export"}
          importBusy={busy === "load"}
          onExport={() => void exportBackup()}
          onFile={(file) => void loadBackup(file)}
        />
        {backup && (
          <div className="space-y-3">
            <p className="text-xs leading-5 text-muted">インポートするファイルを選択してください。既存ファイルは上書きし、未選択のファイルとその編集中の内容は変更しません。選択したファイルの未保存内容は破棄されます。</p>
            {Object.entries(PROMPT_FILE_GROUPS).map(([group, names]) => {
              const available = names.filter((name) => Object.hasOwn(backup.files, name));
              if (!available.length) return null;
              return (
                <fieldset key={group} className="rounded-lg border border-border px-3 py-2">
                  <legend className="px-1 text-xs font-medium">{group}</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {available.map((name) => (
                      <label key={name} className="flex min-h-11 items-center gap-2 text-sm">
                        <input type="checkbox" checked={selected.includes(name)} disabled={disabled} onChange={(event) => setSelected((current) => event.target.checked ? [...current, name] : current.filter((item) => item !== name))} aria-label={`${name}をインポート`} />
                        {name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
            <Button className="w-full max-w-md" variant="primary" busy={busy === "import"} disabled={disabled || selected.length === 0} onClick={() => void importBackup()}>
              <Upload className="h-4 w-4" />選択した{selected.length}件をインポート
            </Button>
          </div>
        )}
      </div>
      {message && <p role="status" className="mt-2 text-xs text-success">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      {error?.includes("保全ファイル:") && <p className="mt-2 text-xs text-muted">保全ファイルが残った場合は「設定 → エンジン → 認証エクスポート → 保全ファイル」で復旧を確認してください。</p>}
    </div>
  );
}
