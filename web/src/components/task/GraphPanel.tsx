"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  GitBranch,
  GitGraph,
  RefreshCw,
} from "lucide-react";
import { Button, Spinner, cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import { layoutGraph, pickBranchBadges, LANE_COLORS, type GraphRow } from "@/lib/graph-layout";
import type {
  GraphFileChange,
  GraphLogPayload,
  GraphShowPayload,
} from "@/lib/types";

const LANE_W = 14;
const ROW_H = 36;
const DOT_R = 4;
const DEFAULT_LIMIT = 80;
/** Poll faster while the agent is actively working (likely to commit soon). */
const POLL_ACTIVE_MS = 4000;
/** Slower baseline poll to pick up commits made outside this session (other terminal, etc.). */
const POLL_IDLE_MS = 15000;

type GraphRepository = { path: string; name: string };

/** 表示に影響するフィールドのみ比較（ポーリング毎の新ペイロードで再描画させない）。 */
export function sameGraphPayload(
  a: GraphLogPayload | null,
  b: GraphLogPayload,
): boolean {
  if (!a) return false;
  if (a.currentBranch !== b.currentBranch || a.hasMore !== b.hasMore) return false;
  if (a.refs.length !== b.refs.length) return false;
  for (let index = 0; index < a.refs.length; index += 1) {
    const left = a.refs[index]!;
    const right = b.refs[index]!;
    if (left.name !== right.name || left.hash !== right.hash || left.current !== right.current) {
      return false;
    }
  }
  if (a.commits.length !== b.commits.length) return false;
  for (let index = 0; index < a.commits.length; index += 1) {
    const left = a.commits[index]!;
    const right = b.commits[index]!;
    if (
      left.hash !== right.hash ||
      left.parents.length !== right.parents.length ||
      left.subject !== right.subject ||
      left.author !== right.author ||
      left.date !== right.date
    ) {
      return false;
    }
    for (let parent = 0; parent < left.parents.length; parent += 1) {
      if (left.parents[parent] !== right.parents[parent]) return false;
    }
  }
  return true;
}

const LANE_STROKE = [
  "var(--accent)",
  "var(--working)",
  "var(--warning)",
  "var(--success)",
  "var(--danger)",
  "var(--muted)",
];

function laneStroke(color: number): string {
  return LANE_STROKE[color % LANE_COLORS] ?? LANE_STROKE[0];
}

function statusTone(s: GraphFileChange["status"]): string {
  if (s === "A") return "bg-success-bg text-success";
  if (s === "D") return "bg-danger-bg text-danger";
  if (s === "M" || s === "R" || s === "C" || s === "T")
    return "bg-warning-bg text-warning";
  return "bg-surface-3 text-muted";
}

// Reuse a single Intl.DateTimeFormat for all rows instead of constructing
// one per commit row on every render.
const COMMIT_DATE_FMT = new Intl.DateTimeFormat("ja-JP", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return COMMIT_DATE_FMT.format(date);
}

function GraphCell({ row }: { row: GraphRow }) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Actual row height measured from the parent button via ResizeObserver.
  // Falls back to ROW_H until the first measurement (or when ResizeObserver
  // is unavailable, e.g. in JSDOM tests).
  const [height, setHeight] = useState(ROW_H);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const target = svg.parentElement;
    if (!target) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) setHeight(h);
      }
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, []);

  const w = Math.max(row.laneCount, 1) * LANE_W + 8;
  const midY = height / 2;
  const x = (lane: number) => 8 + lane * LANE_W + LANE_W / 2;
  const nodeStroke = laneStroke(row.color);

  return (
    <svg
      ref={svgRef}
      width={w}
      height={height}
      className="shrink-0 overflow-visible self-stretch"
      aria-hidden
    >
      {row.passes.map((p) => (
        <line
          key={`pass-${p.lane}`}
          x1={x(p.lane)}
          y1={0}
          x2={x(p.lane)}
          y2={height}
          fill="none"
          stroke={laneStroke(p.color)}
          strokeWidth={2}
        />
      ))}
      {/* rail into commit */}
      <line
        x1={x(row.lane)}
        y1={0}
        x2={x(row.lane)}
        y2={midY}
        fill="none"
        stroke={nodeStroke}
        strokeWidth={2}
      />
      {/* continue first-parent downward */}
      {row.commit.parents.length > 0 && (
        <line
          x1={x(row.lane)}
          y1={midY}
          x2={x(row.lane)}
          y2={height}
          fill="none"
          stroke={nodeStroke}
          strokeWidth={2}
        />
      )}
      {row.edges.map((e, i) => {
        if (e.half === "upper") {
          // side lane from above curves into this commit
          return (
            <path
              key={`e-${i}`}
              d={`M ${x(e.fromLane)} 0 C ${x(e.fromLane)} ${midY * 0.55}, ${x(e.toLane)} ${midY * 0.45}, ${x(e.toLane)} ${midY}`}
              fill="none"
              stroke={laneStroke(e.color)}
              strokeWidth={2}
            />
          );
        }
        // fork from this commit down toward extra parent lane
        return (
          <path
            key={`e-${i}`}
            d={`M ${x(e.fromLane)} ${midY} C ${x(e.fromLane)} ${midY + (height - midY) * 0.45}, ${x(e.toLane)} ${midY + (height - midY) * 0.55}, ${x(e.toLane)} ${height}`}
            fill="none"
            stroke={laneStroke(e.color)}
            strokeWidth={2}
          />
        );
      })}
      <circle
        cx={x(row.lane)}
        cy={midY}
        r={row.commit.parents.length > 1 ? DOT_R + 1 : DOT_R}
        fill="var(--bg)"
        stroke={nodeStroke}
        strokeWidth={row.commit.parents.length > 1 ? 2.5 : 2}
      />
    </svg>
  );
}

/**
 * One commit row. Memoized so unrelated GraphPanel state changes (busy,
 * fileDiff, tab switches…) do not re-run pickBranchBadges/formatCommitDate or
 * re-render the SVG for rows whose inputs are unchanged.
 */
const GraphRowView = memo(function GraphRowView({
  row,
  refs,
  currentBranch,
  expanded,
  loading,
  fileBusy,
  files,
  diff,
  onToggle,
  onOpenFileDiff,
}: {
  row: GraphRow;
  refs: string[];
  currentBranch: string | null;
  expanded: boolean;
  /** This row only — derived from the loadingCommits Set at the call site. */
  loading: boolean;
  fileBusy: boolean;
  /** This row only — derived from filesByCommit at the call site. */
  files: GraphFileChange[] | undefined;
  /** This row only — the open diff if it belongs to this commit. */
  diff: { path: string; text: string } | null;
  onToggle: (hash: string) => void;
  onOpenFileDiff: (commit: string, path: string) => void;
}) {
  const { shown, more } = useMemo(
    () => pickBranchBadges(refs, currentBranch, 2),
    [refs, currentBranch],
  );
  const commitDate = useMemo(
    () => formatCommitDate(row.commit.date),
    [row.commit.date],
  );
  const open = expanded;
  return (
    <div
      className={cx(
        "border-b border-border/60",
        open && "bg-surface-2/60",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`graph-files-${row.commit.hash}`}
        aria-busy={loading || undefined}
        onClick={() => onToggle(row.commit.hash)}
        className="flex w-full min-w-0 cursor-pointer select-text items-stretch gap-1 px-1 py-0 text-left hover:bg-surface-2"
        style={{ minHeight: ROW_H }}
      >
        <GraphCell row={row} />
        <div className="flex min-w-0 flex-1 items-start gap-1 py-1.5 pr-2">
          <ChevronRight
            className={cx(
              "mt-0.5 h-3 w-3 shrink-0 text-faint transition-transform",
              open && "rotate-90",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="min-w-0 break-words text-xs text-text">
              {row.commit.subject || "(no subject)"}
            </div>
            <div className="mt-0.5 min-w-0 text-[10px] text-faint">
              <div className="flex min-w-0 items-center gap-1">
                <span
                  className="min-w-0 flex-1 truncate"
                  title={
                    row.commit.authorEmail
                      ? `作者: ${row.commit.author} <${row.commit.authorEmail}>`
                      : `作者: ${row.commit.author}`
                  }
                >
                  作者: {row.commit.author}
                  {row.commit.authorEmail && ` <${row.commit.authorEmail}>`}
                </span>
                <span
                  title={row.commit.hash}
                  className="inline-flex max-w-full shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-faint"
                >
                  {row.commit.shortHash}
                </span>
              </div>
              {commitDate && (
                <time
                  dateTime={row.commit.date}
                  title={row.commit.date}
                  className="mt-0.5 block truncate"
                >
                  {commitDate}
                </time>
              )}
            </div>
            <div className="mt-1 flex max-w-full flex-wrap items-center gap-1">
              {shown.map((name) => (
                <span
                  key={name}
                  title={name}
                  className={cx(
                    "inline-flex max-w-[7rem] shrink-0 items-center gap-0.5 truncate rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
                    name === currentBranch
                      ? "border-accent/50 bg-accent/15 text-accent"
                      : "border-border bg-surface-2 text-muted",
                  )}
                >
                  <GitBranch className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
              {more > 0 && (
                <span
                  title={refs.join(", ")}
                  className="shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-faint"
                >
                  +{more}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>

      {open && (
        <div
          id={`graph-files-${row.commit.hash}`}
          className="border-t border-border/40 bg-bg/40 px-2 py-1.5 pl-6 sm:pl-10"
        >
          {!files && (
            <div className="flex justify-center py-3">
              <Spinner />
            </div>
          )}
          {files && files.length === 0 && (
            <p className="py-2 text-[11px] text-faint">変更ファイルなし</p>
          )}
          {files?.map((f) => (
            <div key={f.path} className="mb-0.5">
              <button
                type="button"
                disabled={fileBusy || loading}
                onClick={() => onOpenFileDiff(row.commit.hash, f.path)}
                className="flex w-full cursor-pointer select-text items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-2"
              >
                <span
                  className={cx(
                    "w-4 shrink-0 text-center font-mono text-[10px] font-semibold rounded",
                    statusTone(f.status),
                  )}
                >
                  {f.status}
                </span>
                <span className="min-w-0 truncate font-mono text-[11px] text-muted">
                  {f.path}
                </span>
              </button>
              {diff && diff.path === f.path && (
                <pre className="mt-1 max-h-48 overflow-x-auto overflow-y-auto rounded-lg border border-border bg-bg p-2 font-mono text-[10px] leading-4 break-all whitespace-pre text-muted">
                  {diff.text || "(empty diff)"}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export function GraphPanel({
  directory,
  refreshKey,
  working = false,
}: {
  directory: string;
  /** Bump this to force an immediate refetch (e.g. after commit/merge/revert). */
  refreshKey?: number;
  /** Whether the agent is currently running; used to poll faster while it may be committing. */
  working?: boolean;
}) {
  const [payload, setPayload] = useState<GraphLogPayload | null>(null);
  const [repositories, setRepositories] = useState<GraphRepository[]>([]);
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filesByCommit, setFilesByCommit] = useState<
    Record<string, GraphFileChange[]>
  >({});
  const [fileDiff, setFileDiff] = useState<{
    commit: string;
    path: string;
    text: string;
  } | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [loadingCommits, setLoadingCommits] = useState<Set<string>>(
    () => new Set(),
  );
  const commitCountRef = useRef(0);
  const busyRef = useRef(false);
  const detailBusyRef = useRef(new Set<string>());
  const reqIdRef = useRef(0);
  const directoryRef = useRef(selectedDirectory);
  const mountedRef = useRef(false);
  directoryRef.current = selectedDirectory;

  useEffect(() => {
    let cancelled = false;
    setSelectedDirectory(null);
    setRepositories([]);
    setRepositoriesLoading(true);
    setError(null);
    void getJson<{ repositories: GraphRepository[] }>("/api/git/repositories", {
      directory,
    })
      .then((data) => {
        if (cancelled) return;
        setRepositories(data.repositories);
        setSelectedDirectory(data.repositories[0]?.path ?? null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "リポジトリを取得できませんでした");
        }
      })
      .finally(() => {
        if (!cancelled) setRepositoriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory]);

  const load = useCallback(
    async (opts?: { append?: boolean; limit?: number; silent?: boolean }) => {
      const append = Boolean(opts?.append);
      const silent = Boolean(opts?.silent);
      if (!selectedDirectory) return;
      const id = ++reqIdRef.current;
      busyRef.current = true;
      if (!silent) {
        if (append) setLoadingMore(true);
        else setLoading(true);
      }
      if (!silent) setError(null);
      try {
        const skipCount = append ? commitCountRef.current : 0;
        const limit = opts?.limit ?? DEFAULT_LIMIT;
        const data = await getJson<GraphLogPayload>("/api/git/log", {
          directory: selectedDirectory,
          limit: String(limit),
          skip: String(skipCount),
        });
        if (!mountedRef.current || id !== reqIdRef.current) return;
        setPayload((prev) => {
          const next =
            append && prev
              ? {
                  ...data,
                  commits: [...prev.commits, ...data.commits],
                  refs: data.refs,
                }
              : data;
          commitCountRef.current = next.commits.length;
          // ポーリング応答が実質不変なら参照を維持し、グラフ再描画を避ける。
          return sameGraphPayload(prev, next) ? prev : next;
        });
      } catch (err) {
        if (!mountedRef.current || id !== reqIdRef.current) return;
        if (!silent) {
          setError(err instanceof Error ? err.message : "ログの取得に失敗しました");
        }
      } finally {
        if (mountedRef.current && id === reqIdRef.current) {
          busyRef.current = false;
          if (!silent) {
            setLoading(false);
            setLoadingMore(false);
          }
        }
      }
    },
    [selectedDirectory],
  );

  // Always call the latest `load` from effects that must NOT re-fire merely
  // because `load`'s identity changed (e.g. when the selected repository changes, the
  // directory-reset effect below already handles that case on its own).
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reqIdRef.current += 1;
      detailBusyRef.current = new Set();
    };
  }, []);

  useEffect(() => {
    // Invalidate in-flight log/show requests from the previous repository.
    reqIdRef.current += 1;
    busyRef.current = false;
    setPayload(null);
    setExpanded(null);
    setFilesByCommit({});
    setFileDiff(null);
    detailBusyRef.current.clear();
    setLoadingCommits(new Set());
    setError(null); // Clear error when directory changes
    commitCountRef.current = 0;
    if (selectedDirectory) void load();
  }, [selectedDirectory, load]);

  // Refetch immediately when an external action (commit/merge/revert/resync)
  // bumps refreshKey, preserving whatever depth the user had already loaded.
  const skipNextRefreshKey = useRef(true);
  useEffect(() => {
    if (skipNextRefreshKey.current) {
      skipNextRefreshKey.current = false;
      return;
    }
    void loadRef.current({
      limit: Math.max(commitCountRef.current, DEFAULT_LIMIT),
    });
  }, [refreshKey]);

  // Poll in the background so commits made outside this UI (agent shell tool,
  // another terminal, etc.) show up without a manual refresh. Poll faster
  // while the agent is actively working, since that's when a commit is most
  // likely to land.
  useEffect(() => {
    const delay = working ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible" || busyRef.current) return;
      void loadRef.current({
        limit: Math.max(commitCountRef.current, DEFAULT_LIMIT),
        silent: true,
      });
    }, delay);
    return () => clearInterval(id);
  }, [working]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !busyRef.current) {
        void loadRef.current({
          limit: Math.max(commitCountRef.current, DEFAULT_LIMIT),
          silent: true,
        });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const rows = useMemo(
    () => (payload ? layoutGraph(payload.commits) : []),
    [payload],
  );

  const refsByHash = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of payload?.refs ?? []) {
      const list = map.get(r.hash) ?? [];
      list.push(r.name);
      map.set(r.hash, list);
    }
    return map;
  }, [payload?.refs]);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const filesByCommitRef = useRef(filesByCommit);
  filesByCommitRef.current = filesByCommit;
  const selectedDirectoryRef = useRef(selectedDirectory);
  selectedDirectoryRef.current = selectedDirectory;
  const fileDiffRef = useRef(fileDiff);
  fileDiffRef.current = fileDiff;

  const toggleExpand = useCallback(async (hash: string) => {
    if (expandedRef.current === hash) {
      setExpanded(null);
      setFileDiff(null);
      return;
    }
    setExpanded(hash);
    setFileDiff(null);
    if (filesByCommitRef.current[hash]) return;
    const dir = selectedDirectoryRef.current;
    if (!dir) return;
    const detailKey = `${dir}\u0000${hash}`;
    if (detailBusyRef.current.has(detailKey)) return;
    detailBusyRef.current.add(detailKey);
    setLoadingCommits((prev) => new Set(prev).add(hash));
    try {
      const data = await getJson<GraphShowPayload>("/api/git/show", {
        directory: dir,
        commit: hash,
      });
      if (!mountedRef.current || directoryRef.current !== dir) return;
      setFilesByCommit((prev) => ({
        ...prev,
        [hash]: data.files ?? [],
      }));
    } catch (err) {
      if (!mountedRef.current || directoryRef.current !== dir) return;
      setError(err instanceof Error ? err.message : "コミット詳細を取得できませんでした");
    } finally {
      detailBusyRef.current.delete(detailKey);
      if (mountedRef.current && directoryRef.current === dir) {
        setLoadingCommits((prev) => {
          const next = new Set(prev);
          next.delete(hash);
          return next;
        });
      }
    }
  }, []);

  const openFileDiff = useCallback(async (commit: string, path: string) => {
    const current = fileDiffRef.current;
    if (current?.commit === commit && current.path === path) {
      setFileDiff(null);
      return;
    }
    const dir = selectedDirectoryRef.current;
    if (!dir) return;
    setFileBusy(true);
    try {
      const data = await getJson<GraphShowPayload>("/api/git/show", {
        directory: dir,
        commit,
        file: path,
      });
      if (!mountedRef.current || directoryRef.current !== dir) return;
      setFileDiff({ commit, path, text: data.diff ?? "" });
    } catch (err) {
      if (!mountedRef.current || directoryRef.current !== dir) return;
      setError(err instanceof Error ? err.message : "差分を取得できませんでした");
    } finally {
      if (mountedRef.current && directoryRef.current === dir) setFileBusy(false);
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-1 select-text flex-col border-border bg-surface lg:border-l">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5">
        <GitGraph className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="shrink-0 text-xs font-semibold text-muted">グラフ</span>
        {payload?.currentBranch && (
          <span
            title={payload.currentBranch}
            className="inline-flex min-w-0 max-w-full flex-[1_1_7rem] items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text sm:max-w-[10rem]"
          >
            <GitBranch className="h-2.5 w-2.5 shrink-0" />
            <span className="min-w-0 truncate">{payload.currentBranch}</span>
          </span>
        )}
        <span className="min-w-2 flex-1" />
        <Button
          variant="ghost"
          size="icon"
          title="更新"
          aria-label="グラフを更新"
          busy={loading}
          disabled={!selectedDirectory || loading || loadingMore}
          className="h-9 w-9"
          onClick={() => void load()}
        >
          <RefreshCw className={cx("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {repositories.length > 1 && (
        <div
          role="tablist"
          aria-label="グラフのリポジトリ"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2.5 py-1.5"
        >
          {repositories.map((repository) => (
            <button
              key={repository.path}
              type="button"
              role="tab"
              aria-selected={repository.path === selectedDirectory}
              title={repository.path}
              onClick={() => setSelectedDirectory(repository.path)}
              className={cx(
                "shrink-0 select-text rounded-md px-2 py-1 text-xs transition-colors",
                repository.path === selectedDirectory
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              {repository.name}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {(repositoriesLoading || (loading && !payload)) && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {error && (
          <p
            role="alert"
            aria-live="assertive"
            className="border-b border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        )}
        {!repositoriesLoading && !error && repositories.length === 0 && (
          <p className="py-10 text-center text-sm text-faint">
            子リポジトリが見つかりません
          </p>
        )}
        {payload && rows.length === 0 && !loading && (
          <p className="py-10 text-center text-sm text-faint">
            コミットがありません
          </p>
        )}
        {rows.map((row) => (
          <GraphRowView
            key={row.commit.hash}
            row={row}
            refs={refsByHash.get(row.commit.hash) ?? []}
            currentBranch={payload?.currentBranch ?? null}
            expanded={expanded === row.commit.hash}
            loading={loadingCommits.has(row.commit.hash)}
            fileBusy={fileBusy}
            files={filesByCommit[row.commit.hash]}
            diff={
              fileDiff?.commit === row.commit.hash
                ? { path: fileDiff.path, text: fileDiff.text }
                : null
            }
            onToggle={toggleExpand}
            onOpenFileDiff={openFileDiff}
          />
        ))}
        {payload?.hasMore && (
          <div className="flex justify-center py-3">
            <Button
              size="sm"
              variant="secondary"
              busy={loadingMore}
              className="select-text"
              onClick={() => void load({ append: true })}
            >
              さらに読み込む
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
