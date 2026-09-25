"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppWindow, ChevronRight, ChevronUp, FileImage, Folder, RefreshCw, Upload, X } from "lucide-react";
import { Button, Spinner, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type IconEntry = { name: string; path: string; kind: "dir" | "file" };
type IconListing = { path: string; parent: string | null; entries: IconEntry[]; error?: string };

/** ホストPCのフォルダーをアプリ内で辿り、画像またはEXEをプロジェクトアイコンに選ぶ。 */
export function ProjectIconBrowser({
  projectName,
  startPath,
  accept,
  onPick,
  onUpload,
  onClose,
}: {
  projectName: string;
  startPath: string;
  /** 端末からのアップロード用 file input の accept。 */
  accept: string;
  onPick: (icon: string) => void;
  onUpload: (file: File | null) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<IconListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const pickRequestRef = useRef(0);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  /** Resolves true when the listing was loaded. */
  const load = useCallback(async (path?: string): Promise<boolean> => {
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<IconListing>("/api/browse/icon", path ? { path } : undefined);
      if (requestId !== listRequestRef.current) return false;
      setListing(data);
      setError(data.error ?? null);
      return true;
    } catch (err) {
      if (requestId === listRequestRef.current) setError(err instanceof Error ? err.message : "フォルダー一覧を取得できません");
      return false;
    } finally {
      if (requestId === listRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // リポジトリが移動・削除済みなどで開けなければホームから開く。
    void load(startPath).then((ok) => {
      if (!ok && !cancelled) void load();
    });
    closeButtonRef.current?.focus();
    return () => {
      cancelled = true;
      listRequestRef.current += 1;
      pickRequestRef.current += 1;
    };
  }, [load, startPath]);

  // 親のプロジェクト設定ダイアログまで Escape が届かないよう capture で止める。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  async function pick(entry: IconEntry) {
    if (busyPath) return;
    const requestId = ++pickRequestRef.current;
    setBusyPath(entry.path);
    setError(null);
    try {
      const result = await sendJson<{ icon?: string }>("/api/browse/icon", { path: entry.path }, "POST", { timeoutMs: 30_000 });
      if (requestId !== pickRequestRef.current) return;
      if (result.icon) onPick(result.icon);
    } catch (err) {
      if (requestId === pickRequestRef.current) setError(err instanceof Error ? err.message : "アイコンを読み込めません");
    } finally {
      if (requestId === pickRequestRef.current) setBusyPath(null);
    }
  }

  const parent = listing?.parent ?? null;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-2 backdrop-blur-[2px] sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-[min(42rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold">アイコンを選択</h2>
            <p className="mt-0.5 truncate text-xs text-muted" title={projectName}>{projectName}・画像（PNG/JPEG/GIF/WebP/ICO）またはEXE</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
          <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border bg-bg p-1">
            <button
              type="button"
              aria-label="上へ"
              title="上へ"
              disabled={parent === null || loading}
              onClick={() => {
                if (parent !== null) void load(parent);
              }}
              className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <span title={listing?.path} className="min-w-0 flex-1 truncate px-1 text-xs text-muted">
              {listing ? listing.path : "読み込み中…"}
            </span>
            <button
              type="button"
              aria-label="再読み込み"
              title="再読み込み"
              disabled={loading}
              onClick={() => void load(listing?.path ?? startPath)}
              className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />
            </button>
          </div>

          <div aria-busy={loading} className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-y-contain rounded-xl border border-border p-1">
            {listing ? (
              listing.entries.length > 0 ? (
                <ul>
                  {listing.entries.map((entry) => {
                    const isDir = entry.kind === "dir";
                    const isExe = !isDir && entry.name.toLowerCase().endsWith(".exe");
                    const EntryIcon = isDir ? Folder : isExe ? AppWindow : FileImage;
                    return (
                      <li key={entry.path}>
                        <button
                          type="button"
                          disabled={!isDir && busyPath !== null}
                          onClick={() => void (isDir ? load(entry.path) : pick(entry))}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <EntryIcon aria-hidden="true" className={cx("h-4 w-4 shrink-0", isDir ? "text-accent" : "text-muted")} />
                          <span className="min-w-0 flex-1 truncate" title={entry.path}>{entry.name}</span>
                          {busyPath === entry.path && <Spinner className="h-3.5 w-3.5 shrink-0" />}
                          {isDir && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-faint" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-3 py-8 text-center text-sm text-muted">このフォルダーには画像・EXEがありません</p>
              )
            ) : loading || !error ? (
              <div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-muted">
                <Spinner />
                読み込み中…
              </div>
            ) : null}
          </div>
          {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary">
            <Upload aria-hidden="true" className="h-3.5 w-3.5" />
            この端末からアップロード
            <input
              type="file"
              aria-label="この端末からアップロード"
              accept={accept}
              className="sr-only"
              onChange={(event) => {
                onUpload(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <Button variant="ghost" size="sm" onClick={onClose}>閉じる</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
