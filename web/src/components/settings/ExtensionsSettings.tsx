"use client";

import { useCallback, useEffect, useState } from "react";
import { IntercomSettings } from "@/components/settings/IntercomSettings";
import { Badge, Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type ExtensionDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  filePath: string;
  source: "user" | "bundled";
  required: boolean;
};

type ExtensionsResponse = {
  extensions: ExtensionDto[];
  extensionsDir: string;
  bundledExtensionsDir?: string | null;
};

export function ExtensionsSettings() {
  const [extensions, setExtensions] = useState<ExtensionDto[]>([]);
  const [extensionsPath, setExtensionsPath] = useState<string>("");
  const [bundledExtensionsPath, setBundledExtensionsPath] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<ExtensionsResponse>("/api/extensions")
      .then((result) => {
        setExtensions(result.extensions);
        setExtensionsPath(result.extensionsDir);
        setBundledExtensionsPath(result.bundledExtensionsDir ?? null);
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

  const bundledExtensions = extensions.filter((extension) => extension.source === "bundled");
  const userExtensions = extensions.filter((extension) => extension.source !== "bundled");

  function renderExtensionItems(items: ExtensionDto[]) {
    if (items.length === 0) {
      return <p className="mt-3 text-sm text-muted">該当する拡張機能はありません。</p>;
    }
    return (
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {items.map((extension) => (
          <li
            key={extension.id}
            aria-busy={busyId === extension.id || undefined}
            className="rounded-xl border border-border bg-surface-2 px-3 py-2.5"
          >
            <div className="flex items-start gap-3">
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
            </div>
            {extension.id === "leafcode-intercom" && (
              <div id="extensions-intercom" className="mt-3 scroll-mt-24 border-t border-border pt-3">
                <IntercomSettings />
              </div>
            )}
          </li>
        ))}
      </ul>
    );
  }

  function renderExtensionSection(
    id: string,
    title: string,
    description: string | undefined,
    items: ExtensionDto[],
    path: string | null,
  ) {
    return (
      <section data-testid={id} className="rounded-xl border border-border bg-surface-2 p-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold">{title}</h4>
          <Badge tone="neutral">{items.length}件</Badge>
        </div>
        {description && <p className="mt-1 text-xs text-muted">{description}</p>}
        {path && <p className="mt-1 break-all font-mono text-[11px] text-muted">{path}</p>}
        {renderExtensionItems(items)}
      </section>
    );
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
        組み込みとユーザー追加の拡張機能を別枠で表示し、有効／無効を切り替えます。無効化は状態ファイルに記録し、開いているセッションへ即時反映します。
      </p>
      {loading && extensions.length === 0 ? (
        <p className="mt-3 text-sm text-muted">読み込み中…</p>
      ) : (
        <div className="mt-3 space-y-3">
          {renderExtensionSection(
            "extensions-bundled",
            "組み込み",
            undefined,
            bundledExtensions,
            bundledExtensionsPath,
          )}
          {renderExtensionSection(
            "extensions-user",
            "ユーザー追加",
            undefined,
            userExtensions,
            extensionsPath,
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
