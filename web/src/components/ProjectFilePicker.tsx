"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronRight,
  ChevronUp,
  FileText,
  Folder,
  RefreshCw,
  X,
} from "lucide-react";
import { COMPOSER_ACTION_BUTTON_CLASS, type ComposerAttachment } from "@/components/Composer";
import { Button, Spinner, cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import type { WorkspaceEntryDto, WorkspaceFileDto, WorkspaceListingDto } from "@/lib/types";

/** 添付名は 255 コードポイント超で先頭が省略されるため、末尾一致でも選択済みと判定する。 */
function attachmentMatchesPath(name: string | undefined, path: string): boolean {
  if (!name) return false;
  if (name === path) return true;
  return name.startsWith("…") && path.endsWith(name.slice(1));
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KiB`;
}

export function ProjectFilePicker({
  projectId,
  taskId,
  attachments,
  onPick,
  disabled = false,
}: {
  /** 指定時はプロジェクトルートを、未指定なら `taskId` の作業フォルダーを対象にする。 */
  projectId?: string | null;
  taskId?: string | null;
  attachments: readonly ComposerAttachment[];
  onPick: (attachment: ComposerAttachment) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<WorkspaceListingDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const readRequestRef = useRef(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();

  const scopedToProject = Boolean(projectId);
  const title = scopedToProject ? "プロジェクトのファイルを明示" : "作業フォルダーのファイルを選択";
  const endpoint = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/files`
    : taskId
      ? `/api/tasks/${encodeURIComponent(taskId)}/files`
      : null;
  const alreadyPicked = (path: string) =>
    attachments.some((attachment) => attachmentMatchesPath(attachment.name, path));

  const load = useCallback(
    async (next?: string) => {
      if (!endpoint) return;
      const requestId = ++listRequestRef.current;
      setLoading(true);
      setError(null);
      try {
        const data = await getJson<WorkspaceListingDto>(
          endpoint,
          next ? { path: next } : undefined,
        );
        if (requestId !== listRequestRef.current) return;
        setListing(data);
      } catch (err) {
        if (requestId === listRequestRef.current) {
          setError(err instanceof Error ? err.message : "ファイル一覧を取得できません");
        }
      } finally {
        if (requestId === listRequestRef.current) setLoading(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    if (!open) return;
    void load();
    return () => {
      listRequestRef.current += 1;
      readRequestRef.current += 1;
    };
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // モーダル内へフォーカスを移し、閉じたら元のボタンへ戻す（キーボード操作の継続性）。
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  if (!endpoint) return null;

  async function pick(entry: WorkspaceEntryDto) {
    if (busyPath || alreadyPicked(entry.path)) return;
    const requestId = ++readRequestRef.current;
    setBusyPath(entry.path);
    setError(null);
    try {
      const file = await getJson<WorkspaceFileDto>(endpoint!, { path: entry.path, read: "1" });
      if (requestId !== readRequestRef.current) return;
      onPick({
        uri: `data:${file.mimeType};base64,${file.data}`,
        mime: file.mimeType,
        name: file.name,
      });
    } catch (err) {
      if (requestId === readRequestRef.current) {
        setError(err instanceof Error ? err.message : "ファイルを読み込めません");
      }
    } finally {
      if (requestId === readRequestRef.current) setBusyPath(null);
    }
  }

  const parent = listing?.parent ?? null;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled}
      title={title}
      aria-label={title}
      onClick={() => {
        setListing(null);
        setError(null);
        setOpen(true);
      }}
      className={`${COMPOSER_ACTION_BUTTON_CLASS} bg-surface-2 px-0 text-muted hover:bg-surface-3 hover:text-text`}
    >
      <Folder className="h-4 w-4" />
    </button>
  );

  return (
    <>
      {trigger}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-2 backdrop-blur-[2px] sm:p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="flex h-[min(42rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
                  <p className="mt-0.5 text-xs text-muted">ファイルはダブルクリックで添付します。UTF-8テキストのみ対応。</p>
                </div>
                <button
                  ref={closeButtonRef}
                  type="button"
                  aria-label="閉じる"
                  onClick={() => setOpen(false)}
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
                  <span
                    title={listing?.path || undefined}
                    className="min-w-0 flex-1 truncate px-1 text-xs text-muted"
                  >
                    {listing ? listing.path || "/" : "読み込み中…"}
                  </span>
                  <button
                    type="button"
                    aria-label="再読み込み"
                    title="再読み込み"
                    disabled={loading}
                    onClick={() => void load(listing?.path ?? "")}
                    className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />
                  </button>
                </div>

                <div
                  aria-busy={loading}
                  className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-y-contain rounded-xl border border-border p-1"
                >
                  {listing ? (
                    listing.entries.length > 0 ? (
                      <ul>
                        {listing.entries.map((entry) => {
                          const selected = entry.kind === "file" && alreadyPicked(entry.path);
                          const isDir = entry.kind === "dir";
                          return (
                            <li key={entry.path}>
                              <button
                                type="button"
                                aria-pressed={isDir ? undefined : selected}
                                disabled={!isDir && busyPath !== null}
                                onClick={(event) => {
                                  if (isDir) void load(entry.path);
                                  else if (event.detail === 0) void pick(entry);
                                }}
                                onDoubleClick={() => {
                                  if (!isDir) void pick(entry);
                                }}
                                className={cx(
                                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40",
                                  selected && "bg-accent/10 text-accent",
                                )}
                              >
                                {isDir ? (
                                  <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />
                                ) : (
                                  <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                                )}
                                <span className="min-w-0 flex-1 truncate" title={entry.path}>
                                  {entry.name}
                                </span>
                                {!isDir && busyPath === entry.path && (
                                  <Spinner className="h-3.5 w-3.5 shrink-0" />
                                )}
                                {!isDir && selected && (
                                  <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                                )}
                                {!isDir && !selected && entry.size !== undefined && (
                                  <span className="shrink-0 text-[11px] text-faint">
                                    {formatSize(entry.size)}
                                  </span>
                                )}
                                {isDir && (
                                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-faint" />
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="px-3 py-8 text-center text-sm text-muted">
                        このフォルダーにはファイルがありません
                      </p>
                    )
                  ) : (
                    <div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-muted">
                      <Spinner />
                      読み込み中…
                    </div>
                  )}
                </div>

                {listing?.truncated && (
                  <p className="mt-2 text-xs text-muted">
                    件数が多いため一部のみ表示しています。フォルダーを絞ってください。
                  </p>
                )}
                {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
              </div>

              <div className="flex justify-end border-t border-border px-4 py-3">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  閉じる
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
