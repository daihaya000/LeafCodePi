"use client";

import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { ChevronRight, Folder, FolderPlus, Plus, X } from "lucide-react";
import { Button, Spinner, cx } from "@/components/ui";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import type { ProjectDto } from "@/lib/types";

type DirEntry = { name: string; path: string };
type DirList = {
  path: string | null;
  parent: string | null;
  quickAccess?: DirEntry[];
  entries: DirEntry[];
  error?: string;
};

type Props = {
  onAdded?: (project: ProjectDto) => void;
  variant?: "button" | "icon";
  icon?: "folder" | "plus";
  className?: string;
  label?: string;
  buttonVariant?: ComponentProps<typeof Button>["variant"];
  buttonSize?: ComponentProps<typeof Button>["size"];
};

function isValidPathShape(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\\\");
}

/** ネイティブダイアログはホスト PC の画面に開く。リモートからは要求しない。 */
function isWindowsClient(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return [nav.userAgentData?.platform, navigator.platform, navigator.userAgent]
    .filter((v): v is string => typeof v === "string")
    .some((v) => /win/i.test(v));
}

function isLoopbackClientUrl(): boolean {
  if (typeof location === "undefined") return false;
  const hostname = location.hostname.toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function AddProjectButton({
  onAdded,
  variant = "button",
  icon = "folder",
  className,
  label = "プロジェクトを追加",
  buttonVariant = "secondary",
  buttonSize = "sm",
}: Props) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadDir();
  }, [open]);

  async function loadDir(next?: string) {
    try {
      const data = await getJson<DirList>("/api/browse/dirs", next ? { path: next } : undefined);
      setListing(data);
      if (data.path) setPath(data.path);
      setError(data.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "フォルダ一覧を取得できません");
    }
  }

  async function add(rootPath: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ project: ProjectDto }>("/api/projects", { rootPath });
      notifyTasksChanged();
      onAdded?.(result.project);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "追加に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  /** 本家同様: ホスト PC ではクリック時にエクスプローラーを直接開き、選択したら即追加。 */
  async function openNativeOrDialog() {
    if (isWindowsClient() && isLoopbackClientUrl()) {
      setBusy(true);
      setError(null);
      try {
        const result = await sendJson<{ path?: string; cancelled?: boolean }>(
          "/api/browse/dirs",
          {},
          "POST",
          { timeoutMs: 135_000 },
        );
        if (result.path) {
          await add(result.path);
        }
        // キャンセルは無操作で閉じる
        return;
      } catch (err) {
        setError(err instanceof Error ? err.message : "フォルダ選択に失敗しました");
      } finally {
        setBusy(false);
      }
    }
    // リモート端末・ネイティブ起動失敗は従来通りアプリ内一覧へ
    setOpen(true);
  }

  async function nativePick() {
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ path?: string; cancelled?: boolean; error?: string }>(
        "/api/browse/dirs",
        {},
      );
      if (result.path) {
        setPath(result.path);
        await loadDir(result.path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "フォルダ選択に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const trigger =
    variant === "icon" ? (
      <button
        type="button"
        aria-label={label}
        title={label}
        className={cx(
          "inline-flex items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-text",
          className,
        )}
        onClick={() => void openNativeOrDialog()}
      >
        {icon === "plus" ? <Plus className="h-4 w-4" /> : <FolderPlus className="h-4 w-4" />}
      </button>
    ) : (
      <Button
        variant={buttonVariant}
        size={buttonSize}
        className={className}
        busy={busy}
        onClick={() => void openNativeOrDialog()}
      >
        <FolderPlus className="h-3.5 w-3.5" />
        {label}
      </Button>
    );

  return (
    <>
      {trigger}
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-label="プロジェクトを追加"
            className="flex max-h-[min(32rem,90vh)] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">プロジェクトを追加</h2>
              <button type="button" aria-label="閉じる" onClick={() => setOpen(false)} className="rounded-lg p-1 text-muted hover:bg-surface-2">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <div className="flex gap-2">
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="C:\path\to\project"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm"
                />
                <Button size="sm" onClick={() => void nativePick()} busy={busy}>
                  参照
                </Button>
              </div>
              {listing && (
                <div className="rounded-xl border border-border">
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
                    {listing.parent && (
                      <button type="button" className="hover:text-text" onClick={() => void loadDir(listing.parent!)}>
                        上へ
                      </button>
                    )}
                    <span className="min-w-0 truncate font-mono">{listing.path}</span>
                  </div>
                  {listing.quickAccess && listing.quickAccess.length > 0 && (
                    <div className="flex flex-wrap gap-1 border-b border-border px-2 py-2">
                      {listing.quickAccess.map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          onClick={() => void loadDir(entry.path)}
                          className="rounded-md bg-surface-2 px-2 py-1 text-[11px] text-muted hover:text-text"
                        >
                          {entry.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <ul className="max-h-48 overflow-y-auto p-1">
                    {listing.entries.map((entry) => (
                      <li key={entry.path}>
                        <button
                          type="button"
                          onClick={() => void loadDir(entry.path)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                        >
                          <Folder className="h-3.5 w-3.5 text-muted" />
                          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                          <ChevronRight className="h-3 w-3 text-faint" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {error && <p className="text-sm text-danger">{error}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                キャンセル
              </Button>
              <Button
                variant="primary"
                size="sm"
                busy={busy}
                disabled={!isValidPathShape(path)}
                onClick={() => void add(path.trim())}
              >
                {busy ? <Spinner /> : null}
                追加
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
