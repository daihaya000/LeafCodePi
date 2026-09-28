"use client";

import { useEffect, useState } from "react";
import { Archive, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";
import { SettingsDisclosure, TransferActions } from "@/components/settings/TransferControls";

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : "設定の処理に失敗しました";
}

type ProfileBackup = { name: string; createdAt: string };

export function ProfileSettings() {
  const [busy, setBusy] = useState<"backup" | "export" | "import" | "packages" | "restore" | "reset" | null>(null);
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
    if (!window.confirm("認証情報とWebUIパスワードを含む設定一式をエクスポートします。安全な場所に保管してください。")) return;
    setBusy("export");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/profile", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const filename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1]
        ?? `leafcode-pi-profile-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.lcp.gz`;
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("設定をエクスポートしました");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "設定のエクスポートに失敗しました");
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
      setMessage(`${result.fileCount ?? 0}件を復元しました。以前の設定はバックアップへ退避済みです。必要ならパッケージを再取得してください`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "設定のインポートに失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const restorePackages = async () => {
    if (!window.confirm("設定に登録されたパッケージをネットワークから再取得します。パッケージの配布元を信頼できる場合のみ続行してください。")) return;
    setBusy("packages");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore-packages" }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { packageCount?: number };
      setMessage(`${result.packageCount ?? 0}件のパッケージを再取得しました。LeafCodePiを再起動してください`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "パッケージの再取得に失敗しました");
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
      setError(reason instanceof Error ? reason.message : "設定のバックアップに失敗しました");
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
      setMessage(`${result.fileCount ?? 0}件をバックアップから復元しました。以前の設定はバックアップへ退避済みです。必要ならパッケージを再取得してください`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "設定の復元に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const resetProfile = async () => {
    if (!window.confirm("設定を初期化します。旧設定はバックアップへ退避し、認証情報・追加エージェント・拡張などを削除します。完了後にLeafCodePiを再起動してください。")) return;
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
      setError(reason instanceof Error ? reason.message : "設定の初期化に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">設定エクスポート</h3>
      <p className="mt-1 text-xs leading-5 text-muted">
        Pi認証・モデル・MCP設定、エージェント、拡張、スキル、LeafCodePi設定を一式で1ファイルへ保存・復元します。会話、プロジェクト、OS資格情報ストア、再取得できるパッケージ本体は含みません。
      </p>
      <div className="mt-3 space-y-4">
        <TransferActions
          accept=".lcp.gz,application/gzip"
          fileLabel="設定ファイルを選択"
          disabled={disabled}
          exportBusy={busy === "export"}
          importBusy={busy === "import"}
          onExport={() => void exportProfile()}
          onFile={(file) => void importProfile(file)}
        />
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Button className="w-full" variant="secondary" busy={busy === "backup"} disabled={disabled} onClick={() => void backupProfile()}>
              <Archive className="h-4 w-4" />バックアップ
            </Button>
            <Button className="w-full" variant="secondary" busy={busy === "restore"} disabled={disabled || !selectedBackup} onClick={() => void restoreProfile()}>
              <History className="h-4 w-4" />復元
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {backups.length > 0 && (
              <select
                aria-label="復元するバックアップ"
                className="h-10 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text"
                value={selectedBackup}
                disabled={disabled}
                onChange={(event) => setSelectedBackup(event.target.value)}
              >
                {backups.map((backup) => (
                  <option key={backup.name} value={backup.name}>{new Date(backup.createdAt).toLocaleString("ja-JP")}</option>
                ))}
              </select>
            )}
            <Button className="w-full" variant="secondary" busy={busy === "packages"} disabled={disabled} onClick={() => void restorePackages()}>
              <Archive className="h-4 w-4" />パッケージを再取得
            </Button>
          </div>
        </div>
        <SettingsDisclosure title="設定の初期化">
          <Button className="w-full" variant="danger" busy={busy === "reset"} disabled={disabled} onClick={() => void resetProfile()}>
            <RotateCcw className="h-4 w-4" />初期化
          </Button>
        </SettingsDisclosure>
      </div>
      {message && <p role="status" className="mt-2 text-xs text-success">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
