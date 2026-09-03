"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, cx } from "@/components/ui";
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

function ExtensionSwitch({
  name,
  enabled,
  busy,
  locked,
  onToggle,
}: {
  name: string;
  enabled: boolean;
  busy: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${name} を${enabled ? "無効化" : "有効化"}`}
      disabled={busy || locked}
      title={locked ? "WebUI が依存する拡張機能のため無効化できません" : undefined}
      onClick={onToggle}
      className={cx(
        "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        enabled ? "bg-primary" : "bg-surface-3",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform",
          enabled ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}

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
        <h2 className="text-sm font-semibold">拡張機能</h2>
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
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-faint">
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
                  <p className="mt-0.5 text-xs break-words text-faint">{extension.description}</p>
                )}
                <p className="mt-0.5 break-all font-mono text-[11px] text-faint">{extension.filePath}</p>
                {extension.required && (
                  <p className="mt-0.5 text-[11px] text-muted">
                    {extension.enabled
                      ? "WebUI が依存するため無効化できません"
                      : "WebUI が依存するため有効化が必要です"}
                  </p>
                )}
              </div>
              <ExtensionSwitch
                name={extension.name}
                enabled={extension.enabled}
                busy={busyId === extension.id}
                locked={extension.required && extension.enabled}
                onToggle={() => void toggle(extension)}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
