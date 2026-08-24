"use client";

import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronUp,
  Cloud,
  Download,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Image as ImageIcon,
  Monitor,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Button, Spinner, cx } from "@/components/ui";
import { notifyTasksChanged } from "@/lib/events";
import { getJson, sendJson } from "@/lib/client";
import type { ProjectDto } from "@/lib/types";

type EntryKind = "home" | "oneDrive" | "desktop" | "documents" | "downloads" | "pictures" | "project";
type DirEntry = { name: string; path: string; kind?: EntryKind };
type DirList = {
  path: string | null;
  parent: string | null;
  quickAccess?: DirEntry[];
  entries: DirEntry[];
  error?: string;
};

function EntryIcon({ entry }: { entry: DirEntry }) {
  const className = "h-4 w-4 shrink-0";
  if (entry.kind === "home") return <Home aria-hidden="true" className={cx(className, "text-accent")} />;
  if (entry.kind === "oneDrive") return <Cloud aria-hidden="true" className={cx(className, "text-accent")} />;
  if (entry.kind === "desktop") return <Monitor aria-hidden="true" className={cx(className, "text-muted")} />;
  if (entry.kind === "documents") return <FileText aria-hidden="true" className={cx(className, "text-muted")} />;
  if (entry.kind === "downloads") return <Download aria-hidden="true" className={cx(className, "text-muted")} />;
  if (entry.kind === "pictures") return <ImageIcon aria-hidden="true" className={cx(className, "text-muted")} />;
  return <Folder aria-hidden="true" className={cx(className, "text-muted")} />;
}

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

function samePath(left: string | null, right: string): boolean {
  return Boolean(left) && left!.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    void loadDir();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => pathInputRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function loadDir(next?: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<DirList>("/api/browse/dirs", next ? { path: next } : undefined);
      setListing(data);
      if (data.path) setPath(data.path);
      setError(data.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "フォルダ一覧を取得できません");
    } finally {
      setLoading(false);
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

  const quickAccess = listing?.quickAccess ?? [];
  const oneDriveEntries = quickAccess.filter((entry) => entry.kind === "oneDrive");
  const quickEntries = quickAccess.filter((entry) => entry.kind !== "oneDrive" && entry.kind !== "project");
  const projectEntries = quickAccess.filter((entry) => entry.kind === "project");

  function shortcutButton(entry: DirEntry) {
    const active = samePath(listing?.path ?? null, entry.path);
    return (
      <button
        key={entry.path}
        type="button"
        title={entry.path}
        aria-current={active ? "location" : undefined}
        onClick={() => void loadDir(entry.path)}
        className={cx(
          "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-2 hover:text-text",
          active && "bg-accent/10 text-accent",
        )}
      >
        <EntryIcon entry={entry} />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
    );
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
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-2 backdrop-blur-[2px] sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-project-title"
            className="flex max-h-[min(46rem,calc(100vh-2rem))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <h2 id="add-project-title" className="text-sm font-semibold">プロジェクトを追加</h2>
                <p className="mt-0.5 text-xs text-muted">プロジェクトのルートフォルダーを選択</p>
              </div>
              <button
                type="button"
                aria-label="閉じる"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="border-b border-border p-3 sm:p-4">
              <div className="flex gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-bg px-3">
                  <FolderOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                  <input
                    ref={pathInputRef}
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || !isValidPathShape(path)) return;
                      event.preventDefault();
                      void loadDir(path.trim());
                    }}
                    aria-label="フォルダーのパス"
                    placeholder="C:\path\to\project"
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                  />
                </div>
                <Button size="sm" onClick={() => void nativePick()} busy={busy}>
                  参照
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {listing ? (
                <div className="flex h-full min-h-0 flex-col sm:flex-row">
                  <aside className="shrink-0 border-b border-border sm:w-56 sm:border-b-0 sm:border-r">
                    <div className="max-h-40 overflow-y-auto p-2 sm:h-full sm:max-h-none sm:p-3">
                      {quickEntries.length > 0 && (
                        <section>
                          <h3 className="px-2 py-1 text-[11px] font-semibold tracking-wide text-faint">クイックアクセス</h3>
                          <div className="space-y-0.5">{quickEntries.map(shortcutButton)}</div>
                        </section>
                      )}
                      {oneDriveEntries.length > 0 && (
                        <section className="mt-3 border-t border-border pt-3">
                          <h3 className="px-2 py-1 text-[11px] font-semibold tracking-wide text-faint">OneDrive</h3>
                          <div className="space-y-0.5">{oneDriveEntries.map(shortcutButton)}</div>
                        </section>
                      )}
                      {projectEntries.length > 0 && (
                        <section className="mt-3 border-t border-border pt-3">
                          <h3 className="px-2 py-1 text-[11px] font-semibold tracking-wide text-faint">登録済みプロジェクト</h3>
                          <div className="space-y-0.5">{projectEntries.map(shortcutButton)}</div>
                        </section>
                      )}
                    </div>
                  </aside>

                  <section className="flex min-h-0 min-w-0 flex-1 flex-col p-3 sm:p-4">
                    <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border bg-bg p-1">
                      <button
                        type="button"
                        aria-label="上へ"
                        title="上へ"
                        disabled={!listing.parent || loading}
                        onClick={() => listing.parent && void loadDir(listing.parent)}
                        className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <span title={listing.path ?? undefined} className="min-w-0 flex-1 truncate px-1 font-mono text-xs text-muted">
                        {listing.path ?? "場所を読み込めません"}
                      </span>
                      <button
                        type="button"
                        aria-label="再読み込み"
                        title="再読み込み"
                        disabled={loading}
                        onClick={() => void loadDir(listing.path ?? undefined)}
                        className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />
                      </button>
                    </div>

                    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
                      <div className="hidden grid-cols-[auto_minmax(0,1fr)_8rem_auto] items-center gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted sm:grid">
                        <span />
                        <span>名前</span>
                        <span>種類</span>
                        <span />
                      </div>
                      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
                        {listing.entries.length > 0 ? listing.entries.map((entry) => (
                          <li key={entry.path}>
                            <button
                              type="button"
                              onClick={() => void loadDir(entry.path)}
                              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 sm:grid-cols-[auto_minmax(0,1fr)_8rem_auto]"
                            >
                              <Folder aria-hidden="true" className="h-4 w-4 text-accent" />
                              <span className="min-w-0 truncate">{entry.name}</span>
                              <span className="hidden truncate text-xs text-muted sm:block">ファイル フォルダー</span>
                              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-faint" />
                            </button>
                          </li>
                        )) : (
                          <li className="px-3 py-8 text-center text-sm text-muted">このフォルダーにはサブフォルダーがありません</li>
                        )}
                      </ul>
                    </div>
                    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
                  </section>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-muted">
                  <Spinner />
                  読み込み中…
                </div>
              )}
            </div>

            {error && !listing && <p role="alert" className="border-t border-border px-4 py-2 text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                キャンセル
              </Button>
              <Button
                variant="primary"
                size="sm"
                busy={busy}
                disabled={loading || !isValidPathShape(path)}
                onClick={() => void add(path.trim())}
              >
                追加
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
