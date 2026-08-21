"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  RefreshCw,
} from "lucide-react";
import { Button, DiffStat, Spinner, cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import type { DiffFile, DiffFilesPayload } from "@/lib/types";
import { tintCodeLine } from "@/lib/difftint";

const MAX_LINES_PER_FILE = 500;

function formatModifiedAt(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function FileDiffBlock({
  file,
  expanded,
  sideBySide,
  onToggle,
}: {
  file: DiffFile;
  expanded: boolean;
  sideBySide: boolean;
  onToggle: () => void;
}) {
  const dir = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
    : "";
  const base = file.path.slice(dir.length);
  let rendered = 0;

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${file.path} の差分を${expanded ? "折りたたむ" : "展開"}`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cx(
              "h-3.5 w-3.5 shrink-0 text-faint transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span className="min-w-0 truncate font-mono text-xs">
            <span className="text-faint">{dir}</span>
            <span className="text-text">{base}</span>
          </span>
          {file.untracked && (
            <span className="shrink-0 rounded-full bg-success-bg px-2 py-0.5 text-[10px] font-medium text-success">
              新規
            </span>
          )}
          {file.binary && (
            <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted">
              バイナリ
            </span>
          )}
          {file.modifiedAt && (
            <span
              className="shrink-0 text-[10px] whitespace-nowrap text-faint"
              title={`最終更新: ${new Date(file.modifiedAt).toLocaleString("ja-JP")}`}
            >
              更新 {formatModifiedAt(file.modifiedAt)}
            </span>
          )}
          <span className="flex-1" />
          <DiffStat additions={file.additions} deletions={file.deletions} className="shrink-0" />
        </button>
      </div>
      {expanded && !file.binary && file.hunks.length > 0 && (
        <div className="overflow-x-auto border-t border-border font-mono text-xs leading-5">
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="bg-diff-hunk-bg px-3 py-0.5 text-faint select-none">
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => {
                if (rendered >= MAX_LINES_PER_FILE) return null;
                rendered += 1;
                if (sideBySide) {
                  if (line.t === "-") {
                    return (
                      <div
                        key={li}
                        className="grid grid-cols-1 bg-diff-del-bg text-diff-del-text sm:grid-cols-2"
                      >
                        <div className="border-r border-border px-2 whitespace-pre">
                          -{line.text || " "}
                        </div>
                        <div className="px-2" />
                      </div>
                    );
                  }
                  if (line.t === "+") {
                    return (
                      <div
                        key={li}
                        className="grid grid-cols-1 bg-diff-add-bg text-diff-add-text sm:grid-cols-2"
                      >
                        <div className="border-r border-border px-2" />
                        <div className="px-2 whitespace-pre">+{line.text || " "}</div>
                      </div>
                    );
                  }
                  return (
                    <div key={li} className="grid grid-cols-1 text-muted sm:grid-cols-2">
                      <div className="border-r border-border px-2 whitespace-pre">
                        {line.text || " "}
                      </div>
                      <div className="px-2 whitespace-pre">{line.text || " "}</div>
                    </div>
                  );
                }
                return (
                  <div
                    key={li}
                    className={cx(
                      "flex px-3 whitespace-pre",
                      line.t === "+" && "bg-diff-add-bg text-diff-add-text",
                      line.t === "-" && "bg-diff-del-bg text-diff-del-text",
                      line.t === " " && "text-muted",
                    )}
                  >
                    <span className="w-4 shrink-0 select-none">
                      {line.t === " " ? "" : line.t}
                    </span>
                    <span
                      dangerouslySetInnerHTML={{
                        __html: tintCodeLine(line.text || " ", file.path),
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ))}
          {rendered >= MAX_LINES_PER_FILE && (
            <p className="px-3 py-1.5 text-faint">
              …長いため省略（{MAX_LINES_PER_FILE}行まで表示）
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffPane({
  directory,
  refreshKey,
}: {
  directory: string;
  /** Bump this to force an immediate refetch (e.g. after commit/merge/revert). */
  refreshKey?: number;
}) {
  const [payload, setPayload] = useState<DiffFilesPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sideBySide, setSideBySide] = useState(false);
  const [filter, setFilter] = useState<"all" | "tracked" | "untracked">("all");
  const reqIdRef = useRef(0);
  const mountedRef = useRef(false);
  const directoryRef = useRef(directory);
  directoryRef.current = directory;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reqIdRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<DiffFilesPayload>("/api/diff/files", { directory });
      if (!mountedRef.current || id !== reqIdRef.current) return;
      setPayload(data);
      setExpanded((prev) => {
        const next: Record<string, boolean> = {};
        for (const f of data.files) {
          next[f.path] = prev[f.path] ?? false;
        }
        return next;
      });
    } catch (err) {
      if (!mountedRef.current || id !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : "diff の取得に失敗しました");
    } finally {
      if (mountedRef.current && id === reqIdRef.current) setLoading(false);
    }
  }, [directory]);

  useEffect(() => {
    reqIdRef.current += 1;
    setPayload(null);
    setError(null);
    setExpanded({});
  }, [directory]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const files = useMemo(() => {
    const all = payload?.files ?? [];
    return filter === "untracked"
      ? all.filter((f) => f.untracked)
      : filter === "tracked"
        ? all.filter((f) => !f.untracked)
        : all;
  }, [payload, filter]);

  const allExpanded = files.length > 0 && files.every((f) => expanded[f.path]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      {/* Action bar */}
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-2">
        <span className="mr-1 shrink-0 text-xs font-semibold text-muted">変更</span>
        {payload && (
          <DiffStat additions={payload.additions} deletions={payload.deletions} className="shrink-0" />
        )}
        <span className="min-w-2 flex-1" />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as "all" | "tracked" | "untracked")}
          title="表示する変更の種類"
          aria-label="表示する変更の種類"
          className="h-8 min-w-0 max-w-full flex-[1_1_8rem] cursor-pointer rounded-lg border border-border bg-surface-2 px-2 text-[11px] text-muted outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary sm:max-w-[9.5rem]"
        >
          <option value="all">すべての変更</option>
          <option value="tracked">既存の変更</option>
          <option value="untracked">新規ファイル</option>
        </select>
        <Button
          variant={sideBySide ? "secondary" : "ghost"}
          size="sm"
          className="inline-flex"
          title="左右に並べて差分表示"
          onClick={() => setSideBySide((v) => !v)}
        >
          並列表示
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={allExpanded ? "すべて折りたたむ" : "すべて展開"}
          aria-label={allExpanded ? "すべて折りたたむ" : "すべて展開"}
          onClick={() =>
            setExpanded(Object.fromEntries(files.map((f) => [f.path, !allExpanded])))
          }
        >
          {allExpanded ? (
            <ChevronsDownUp className="h-4 w-4" />
          ) : (
            <ChevronsUpDown className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="更新"
          aria-label="差分を更新"
          busy={loading}
          onClick={() => void load()}
        >
          <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      {error && (
        <div
          className="shrink-0 border-b border-danger/30 bg-danger-bg px-3 py-2 text-xs break-all text-danger"
          role="alert"
          aria-live="assertive"
        >
          {error}
        </div>
      )}

      {/* File list */}
      <div
        className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto p-3"
        aria-busy={loading || undefined}
      >
        {!payload && loading && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {payload && !payload.git && (
          <p className="py-10 text-center text-sm text-faint" role="status" aria-live="polite">
            {payload.error || "このディレクトリは Git リポジトリではありません"}
          </p>
        )}
        {payload?.git && files.length === 0 && (
          <p className="py-10 text-center text-sm text-faint" role="status" aria-live="polite">
            {payload.error ||
              (payload.files.length === 0
                ? "変更はありません"
                : `${filter === "tracked" ? "既存の変更" : "新規ファイル"}はありません`)}
          </p>
        )}
        {files.map((f) => (
          <FileDiffBlock
            key={f.path}
            file={f}
            expanded={Boolean(expanded[f.path])}
            sideBySide={sideBySide}
            onToggle={() =>
              setExpanded((prev) => ({ ...prev, [f.path]: !prev[f.path] }))
            }
          />
        ))}
      </div>
    </div>
  );
}
