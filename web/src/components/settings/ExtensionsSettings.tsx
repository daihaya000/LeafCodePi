"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type ExtensionDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  filePath: string;
  required: boolean;
};

type ExtensionsResponse = {
  extensions: ExtensionDto[];
  extensionsDir: string;
};

export function ExtensionsSettings() {
  const [extensions, setExtensions] = useState<ExtensionDto[]>([]);
  const [extensionsPath, setExtensionsPath] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<ExtensionsResponse>("/api/extensions")
      .then((result) => {
        setExtensions(result.extensions);
        setExtensionsPath(result.extensionsDir);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "拡張機能一覧の取得に失敗しました");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggle(extension: ExtensionDto) {
    if (busyId) return;
    setBusyId(extension.id);
    setError(null);
    try {
      const result = await sendJson<{ extensions: ExtensionDto[] }>(
        `/api/extensions/${encodeURIComponent(extension.id)}`,
        { enabled: !extension.enabled },
        "PATCH",
      );
      setExtensions(result.extensions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "拡張機能の切替に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">拡張機能</h3>
        <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || Boolean(busyId)}>
          再読込
        </Button>
      </div>
      <p className="text-xs text-muted">
        Pi が読むグローバル拡張機能（
        <span className="font-mono">~/.pi/agent/extensions</span>
        ）を有効／無効にします。無効化は状態ファイルに記録し、開いているセッションへ即時反映します。
      </p>
      {extensionsPath && (
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
          <p className="break-all">{extensionsPath}</p>
        </div>
      )}
      {loading && extensions.length === 0 ? (
        <p className="mt-3 text-sm text-muted">読み込み中…</p>
      ) : extensions.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          拡張機能がありません。{" "}
          <span className="font-mono">~/.pi/agent/extensions/&lt;name&gt;/index.js</span>{" "}
          などを追加してください。
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {extensions.map((extension) => (
            <li
              key={extension.id}
              aria-busy={busyId === extension.id || undefined}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-text" title={extension.id}>
                    {extension.name}
                  </p>
                  <Badge tone={extension.enabled ? "success" : "neutral"}>
                    {extension.enabled ? "有効" : "無効"}
                  </Badge>
                </div>
                {extension.description && (
                  <p className="mt-0.5 text-xs break-words text-muted">{extension.description}</p>
                )}
                <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{extension.filePath}</p>
                {extension.required && (
                  <p className="mt-0.5 text-[11px] text-muted">
                    {extension.enabled
                      ? "WebUI が依存するため無効化できません"
                      : "WebUI が依存するため有効化が必要です"}
                  </p>
                )}
              </div>
              <Switch
                checked={extension.enabled}
                onChange={() => void toggle(extension)}
                label={`${extension.name} を${extension.enabled ? "無効化" : "有効化"}`}
                busy={busyId === extension.id}
                disabled={extension.required && extension.enabled}
                title={extension.required && extension.enabled ? "WebUI が依存する拡張機能のため無効化できません" : undefined}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
