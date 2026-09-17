"use client";

import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button, cx } from "@/components/ui";

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : "プロファイルの処理に失敗しました";
}

export function ProfileSettings() {
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      link.click();
      URL.revokeObjectURL(url);
      setMessage("プロファイルを保存しました");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "プロファイルのエクスポートに失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const importProfile = async (file: File) => {
    if (!window.confirm("現在の設定・認証情報・追加エージェント/拡張を置き換えます。完了後にLeafCodePiを再起動してください。")) return;
    setBusy("import");
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("profile", file);
      const response = await fetch("/api/profile", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { fileCount?: number };
      setMessage(`${result.fileCount ?? 0}件を復元しました。LeafCodePiを再起動してください`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "プロファイルのインポートに失敗しました");
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
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" busy={busy === "export"} disabled={disabled} onClick={() => void exportProfile()}>
          <Download className="h-4 w-4" />エクスポート
        </Button>
        <label className={cx("inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 px-3.5 text-sm text-text transition-colors hover:bg-surface-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent", disabled && "pointer-events-none opacity-40")}>
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
      {message && <p role="status" className="mt-2 text-xs text-success">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
