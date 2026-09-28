"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui";
import { sendJson } from "@/lib/client";
import {
  MAX_PROMPT_BACKUP_BYTES, PROMPT_FILE_GROUPS, PROMPT_FILE_NAMES, type PromptBackup, type PromptFileName,
} from "@/lib/prompt-transfer-format";

export function PromptTransfer({ onImported }: { onImported: (imported: PromptFileName[]) => void }) {
  const [backup, setBackup] = useState<PromptBackup | null>(null);
  const [selected, setSelected] = useState<PromptFileName[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportBackup() {
    if (!window.confirm("プロンプトに個人情報や秘密情報が含まれる場合があります。安全な場所に保存しますか？")) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function loadBackup(file: File) {
    setBusy(true);
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
      if (fileRef.current) fileRef.current.value = "";
      setBusy(false);
    }
  }

  async function importBackup() {
    if (!backup || !selected.length || busy) return;
    if (!window.confirm(`${selected.join("、")} を上書きします。選択していないファイルは変更しません。選択したファイルの編集中の未保存内容は破棄されます。続行しますか？`)) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h4 className="text-sm font-semibold">プロンプトの転送</h4>
      <p className="mt-1 text-xs text-muted">この画面の7つのグローバルMarkdownファイルだけを転送します。認証・送信プロンプトのプリセットは対象外です。バックアップには個人情報や秘密情報が含まれ得ます。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" busy={busy} disabled={busy} onClick={() => void exportBackup()}>エクスポート</Button>
        <label className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-border bg-surface-2 px-3 text-sm text-text has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:disabled]:opacity-50">
          JSONを選択
          <input ref={fileRef} type="file" accept=".json,application/json" disabled={busy} aria-label="プロンプトのバックアップJSONを選択" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadBackup(file); }} />
        </label>
      </div>
      {backup && (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted">インポートするファイルを選択してください。既存ファイルは上書きし、未選択のファイルとその編集中の内容は変更しません。選択したファイルの未保存内容は破棄されます。</p>
          {Object.entries(PROMPT_FILE_GROUPS).map(([group, names]) => {
            const available = names.filter((name) => Object.hasOwn(backup.files, name));
            if (!available.length) return null;
            return (
              <fieldset key={group} className="rounded-lg border border-border px-3 py-2">
                <legend className="px-1 text-xs font-medium">{group}</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {available.map((name) => (
                    <label key={name} className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" checked={selected.includes(name)} disabled={busy} onChange={(event) => setSelected((current) => event.target.checked ? [...current, name] : current.filter((item) => item !== name))} aria-label={`${name}をインポート`} />
                      {name}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
          <Button type="button" size="sm" variant="primary" busy={busy} disabled={busy || selected.length === 0} onClick={() => void importBackup()}>選択した{selected.length}件をインポート</Button>
        </div>
      )}
      {message && <p role="status" className="mt-3 text-xs text-success">{message}</p>}
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      {error?.includes("保全ファイル:") && <p className="mt-2 text-xs text-muted">保全ファイルが残った場合は「設定 → エンジン → 認証エクスポート」で復旧を確認してください。</p>}
    </div>
  );
}
