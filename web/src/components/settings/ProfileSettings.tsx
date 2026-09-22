"use client";

import { useEffect, useState } from "react";
import { Archive, Download, History, RotateCcw, Upload } from "lucide-react";
import { Button, cx } from "@/components/ui";

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : "プロファイルの処理に失敗しました";
}

type ProfileBackup = { name: string; createdAt: string };

export function ProfileSettings() {
  const [busy, setBusy] = useState<"backup" | "export" | "import" | "restore" | "reset" | null>(null);
  const [backups, setBackups] = useState<ProfileBackup[]>([]);
  const [selectedBackup, setSelectedBackup] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/profile?backups=1", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = await response.json() as { backups?: ProfileBackup[] };
        const values = Array.isArray(result.backups) ? result.backups : [];
        if (!active) return;
        setBackups(values);
        setSelectedBackup(values[0]?.name ?? "");
      })
      .catch(() => { if (active) setBackups([]); });
    return () => { active = false; };
  }, []);

  const rememberBackup = (backupPath?: string) => {
    const name = backupPath?.split(/[\\/]/).at(-1);
    if (!name) return;
    setBackups((current) => current.some((backup) => backup.name === name) ? current : [
      { name, createdAt: new Date().toISOString() },
      ...current,
    ]);
    setSelectedBackup(name);
  };

  const exportProfile = async () => {
    if (!window.confirm("認証情報とWebUIトークンを含む設定プロファイルを保存します。安全な場所に保管してください。")) return;
    setBusy("export");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/profile", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "leafcode-pi-profile.lcp.gz";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("プロファイルを保存しました");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "プロファイルのエクスポートに失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const importProfile = async (file: File) => {
    if (!window.confirm("現在の設定・認証情報・追加エージェント/拡張をバックアップへ退避してから置き換えます。完了後にLeafCodePiを再起動してください。")) return;
    setBusy("import");
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("profile", file);
      const response = await fetch("/api/profile", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { fileCount?: number; backupPath?: string };
      rememberBackup(result.backupPath);
      setMessage(`${result.fileCount ?? 0}件を復元しました。以前の設定はバックアップへ退避済みです。LeafCodePiを再起動してください`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "プロファイルのインポートに失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const backupProfile = async () => {
    setBusy("backup");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/profile", { method: "PATCH" });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { backupPath?: string };
      rememberBackup(result.backupPath);
      setMessage("バックアップを保存しました");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "プロファイルのバックアップに失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const restoreProfile = async () => {
    if (!selectedBackup || !window.confirm("選択した設定バックアップを復元します。現在の設定はバックアップへ退避してから置き換えます。完了後にLeafCodePiを再起動してください。")) return;
    setBusy("restore");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backup: selectedBackup }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { fileCount?: number; backupPath?: string };
      rememberBackup(result.backupPath);
      setMessage(`${result.fileCount ?? 0}件をバックアップから復元しました。以前の設定はバックアップへ退避済みです。LeafCodePiを再起動してください`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "プロファイルの復元に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const resetProfile = async () => {
    if (!window.confirm("設定プロファイルを初期化します。旧設定はバックアップへ退避し、認証情報・追加エージェント・拡張などを削除します。完了後にLeafCodePiを再起動してください。")) return;
    setBusy("reset");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/profile", { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { backupPath?: string };
      rememberBackup(result.backupPath);
      setMessage(`旧設定を${result.backupPath ?? "バックアップ"}へ退避し、初期化しました。LeafCodePiを再起動してください`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "プロファイルの初期化に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">設定プロファイル</h3>
      <p className="mt-1 text-xs leading-5 text-muted">
        Pi認証・モデル・MCP設定、エージェント、拡張、スキル、LeafCodePi設定を1ファイルへ保存・復元します。会話、プロジェクト、OS資格情報ストアは含みません。
      </p>
      <div className="mt-3 space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <Button className="w-full" variant="secondary" busy={busy === "export"} disabled={disabled} onClick={() => void exportProfile()}>
            <Download className="h-4 w-4" />エクスポート
          </Button>
          <label className={cx("inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 px-3.5 text-sm text-text transition-colors hover:bg-surface-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent", disabled && "pointer-events-none opacity-40")}>
            <Upload className="h-4 w-4" />インポート
            <input
              type="file"
              accept=".lcp.gz,application/gzip"
              className="sr-only"
              aria-label="設定プロファイルを選択"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) void importProfile(file);
              }}
            />
          </label>
        </div>
        {backups.length > 0 && (
          <select
            aria-label="復元するバックアップ"
            className="h-10 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text"
            value={selectedBackup}
            disabled={disabled}
            onChange={(event) => setSelectedBackup(event.target.value)}
          >
            {backups.map((backup) => (
              <option key={backup.name} value={backup.name}>{new Date(backup.createdAt).toLocaleString("ja-JP")}</option>
            ))}
          </select>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Button className="w-full" variant="danger" busy={busy === "reset"} disabled={disabled} onClick={() => void resetProfile()}>
            <RotateCcw className="h-4 w-4" />初期化
          </Button>
          <Button className="w-full" variant="secondary" busy={busy === "backup"} disabled={disabled} onClick={() => void backupProfile()}>
            <Archive className="h-4 w-4" />バックアップ
          </Button>
          <Button className="w-full" variant="secondary" busy={busy === "restore"} disabled={disabled || !selectedBackup} onClick={() => void restoreProfile()}>
            <History className="h-4 w-4" />復元
          </Button>
        </div>
      </div>
      {message && <p role="status" className="mt-2 text-xs text-success">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
