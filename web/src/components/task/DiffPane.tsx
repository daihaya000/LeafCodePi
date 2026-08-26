"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CloudUpload,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button, DiffStat, Spinner, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import type { DiffFile, DiffFilesPayload } from "@/lib/types";
import { tintCodeLine } from "@/lib/difftint";
import { suggestCommitMessage } from "@/lib/commit-message";
import {
  directGenerationModelKey,
  parseDirectGenerationModelResponse,
  type DirectGenerationModel,
} from "@/lib/direct-generation-text";

const MAX_LINES_PER_FILE = 500;

type BranchInfo = {
  current: string;
  branches: string[];
  defaultTarget: string | null;
  upstream?: string | null;
  ahead?: number;
  remotes?: string[];
  hasRemote?: boolean;
};

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

/**
 * Memoized tinted diff line. Tinting is pure (text + path → HTML), so lines
 * whose props did not change are never re-tinted on re-render (e.g. toggling
 * 並列表示, busy state changes, or other files expanding/collapsing).
 */
const TintedLine = memo(function TintedLine({
  text,
  path,
}: {
  text: string;
  path: string;
}) {
  return <span dangerouslySetInnerHTML={{ __html: tintCodeLine(text, path) }} />;
});

const FileDiffBlock = memo(function FileDiffBlock({
  file,
  expanded,
  selected,
  sideBySide,
  busy,
  onToggle,
  onSelect,
  onDelete,
}: {
  file: DiffFile;
  expanded: boolean;
  selected: boolean;
  sideBySide: boolean;
  busy: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string, v: boolean) => void;
  onDelete: (path: string) => void;
}) {
  const dir = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
    : "";
  const base = file.path.slice(dir.length);
  let rendered = 0;

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelect(file.path, e.target.checked)}
          className="h-5 w-5 shrink-0 cursor-pointer"
          style={{ accentColor: "var(--accent)" }}
          aria-label={`${file.path} をコミット対象にする`}
        />
        <button
          type="button"
          onClick={() => onToggle(file.path)}
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
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            title="ファイルを削除（コミット対象からも取り除きます）"
            aria-label={`${file.path} を削除`}
            onClick={() => onDelete(file.path)}
            className="hover:bg-danger-bg hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
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
                    <TintedLine text={line.text || " "} path={file.path} />
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
});

export function DiffPane({
  directory,
  agent,
  model,
  refreshKey,
  onMutated,
}: {
  directory: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  /** Bump this to force an immediate refetch (e.g. after commit/merge/revert). */
  refreshKey?: number;
  onMutated?: () => void;
}) {
  const [payload, setPayload] = useState<DiffFilesPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [deselected, setDeselected] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<null | "commit" | "merge" | "pr">(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [commitModel, setCommitModel] = useState<DirectGenerationModel | null>(null);
  const [generatingCommitMessage, setGeneratingCommitMessage] = useState(false);
  const [branches, setBranches] = useState<BranchInfo | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prAvailable, setPrAvailable] = useState<boolean | null>(null);
  const [sideBySide, setSideBySide] = useState(false);
  const [filter, setFilter] = useState<"all" | "tracked" | "untracked">("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const metaReqIdRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const actionBusyRef = useRef(false);
  const mountedRef = useRef(false);
  const directoryRef = useRef(directory);
  directoryRef.current = directory;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reqIdRef.current += 1;
      metaReqIdRef.current += 1;
      actionGenerationRef.current += 1;
      actionBusyRef.current = false;
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
    actionGenerationRef.current += 1;
    setPayload(null);
    setError(null);
    setExpanded({});
    setDeselected({});
    setNotice(null);
    setCommitMsg("");
    setCommitModel(null);
    setGeneratingCommitMessage(false);
    setPrTitle("");
    setMergeTarget("");
    setPanel(null);
  }, [directory]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadMergeMeta = useCallback(async () => {
    const id = ++metaReqIdRef.current;
    const dir = directory;
    try {
      const info = await getJson<BranchInfo>("/api/git/branches", { directory: dir });
      if (id !== metaReqIdRef.current || directoryRef.current !== dir) return;
      setBranches(info);
      setMergeTarget((cur) => cur || info.defaultTarget || "");
    } catch {
      /* non-git dir */
    }
    try {
      const pr = await getJson<{ available: boolean }>("/api/git/pr", {
        directory: dir,
      });
      if (id !== metaReqIdRef.current || directoryRef.current !== dir) return;
      setPrAvailable(Boolean(pr.available));
    } catch {
      if (id !== metaReqIdRef.current || directoryRef.current !== dir) return;
      setPrAvailable(false);
    }
  }, [directory]);

  useEffect(() => {
    metaReqIdRef.current += 1;
    setBranches(null);
    setPrAvailable(null);
    void loadMergeMeta();
  }, [loadMergeMeta]);

  const files = useMemo(() => {
    const all = payload?.files ?? [];
    return filter === "untracked"
      ? all.filter((f) => f.untracked)
      : filter === "tracked"
        ? all.filter((f) => !f.untracked)
        : all;
  }, [payload, filter]);

  const hasChanges = files.length > 0;
  const selectedPaths = useMemo(
    () => files.filter((f) => !deselected[f.path]).map((f) => f.path),
    [files, deselected],
  );
  const allExpanded = files.length > 0 && files.every((f) => expanded[f.path]);

  const run = useCallback(
    async (fn: () => Promise<string>) => {
      if (actionBusyRef.current) return;
      const generation = actionGenerationRef.current;
      actionBusyRef.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const message = await fn();
        if (!mountedRef.current || generation !== actionGenerationRef.current) return;
        setNotice(message);
        setPanel(null);
        await load();
        await loadMergeMeta();
        onMutated?.();
      } catch (err) {
        if (!mountedRef.current || generation !== actionGenerationRef.current) return;
        setError(err instanceof Error ? err.message : "操作に失敗しました");
      } finally {
        actionBusyRef.current = false;
        if (mountedRef.current && generation === actionGenerationRef.current) {
          setBusy(false);
        }
      }
    },
    [load, loadMergeMeta, onMutated],
  );

  const commit = () =>
    run(async () => {
      if (!payload || selectedPaths.length === 0) {
        throw new Error("コミットする変更がありません");
      }
      const body: Record<string, unknown> = {
        directory,
        message: commitMsg.trim(),
        agent,
      };
      if (selectedPaths.length === payload.files.length) body.all = true;
      else body.paths = selectedPaths;
      const res = await sendJson<{ summary?: string }>(
        "/api/git/commit",
        body,
        "POST",
      );
      setCommitMsg("");
      return `コミットしました: ${res.summary ?? ""}`;
    });

  const merge = (into: "current" | "branch") =>
    run(async () => {
      const res = await sendJson<{
        summary?: string;
        merged?: string;
        into?: string;
      }>("/api/git/merge", {
        directory,
        branch: mergeTarget,
        into,
        noFf: true,
      }, "POST");
      return res.summary || `マージしました: ${res.merged} → ${res.into}`;
    });

  const createPr = () =>
    run(async () => {
      const res = await sendJson<{ url?: string }>("/api/git/pr", {
        directory,
        title: prTitle.trim(),
        base: mergeTarget || undefined,
        push: true,
      }, "POST");
      setPrTitle("");
      return res.url ? `PR: ${res.url}` : "PR を作成しました";
    });

  const push = () =>
    run(async () => {
      const hasUpstream = Boolean(branches?.upstream);
      const res = await sendJson<{ summary?: string }>(
        "/api/git/push",
        {
          directory,
          setUpstream: !hasUpstream,
        },
        "POST",
      );
      return `プッシュしました: ${res.summary ?? ""}`;
    });

  // Stable per-path callbacks so memoized FileDiffBlock rows do not re-render
  // when unrelated state (busy, panel, filter…) changes.
  const toggleFile = useCallback((path: string) => {
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const selectFile = useCallback((path: string, v: boolean) => {
    setDeselected((prev) => ({ ...prev, [path]: !v }));
  }, []);

  const deleteFile = (filePath: string) => {
    if (
      !window.confirm(
        `ファイルを削除しますか？\n${filePath}\n（コミット対象からも取り除かれます）`,
      )
    ) {
      return;
    }
    void run(async () => {
      await sendJson("/api/git/rm", { directory, path: filePath }, "POST");
      return `削除しました: ${filePath}`;
    });
  };

  const initializeRepo = () =>
    run(async () => {
      await sendJson("/api/git/init", { directory }, "POST");
      return "Git リポジトリを初期化しました";
    });

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
          variant={panel === "commit" ? "secondary" : "ghost"}
          size="sm"
          aria-label="Commit パネル"
          disabled={!hasChanges}
          onClick={() => setPanel(panel === "commit" ? null : "commit")}
        >
          <GitCommitHorizontal className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Commit</span>
        </Button>
        <Button
          variant={panel === "merge" ? "secondary" : "ghost"}
          size="sm"
          className="inline-flex"
          aria-label="Merge パネル"
          onClick={() => setPanel(panel === "merge" ? null : "merge")}
        >
          <GitMerge className="h-3.5 w-3.5" />
          Merge
        </Button>
        <Button
          variant={panel === "pr" ? "secondary" : "ghost"}
          size="sm"
          className="inline-flex"
          aria-label="PR パネル"
          disabled={prAvailable === false}
          title={prAvailable === false ? "gh CLI が必要です" : undefined}
          onClick={() => setPanel(panel === "pr" ? null : "pr")}
        >
          <GitPullRequest className="h-3.5 w-3.5" />
          PR
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="inline-flex"
          aria-label="現在のブランチをプッシュ"
          disabled={
            !branches?.hasRemote ||
            busy ||
            hasChanges ||
            (branches?.ahead !== undefined && branches.ahead <= 0)
          }
          title={
            !branches?.hasRemote
              ? "リモートが設定されていません"
              : hasChanges
                ? "先にコミットしてください"
                : branches?.upstream
                  ? branches.ahead && branches.ahead > 0
                    ? `${branches.ahead} コミットをプッシュ`
                    : "プッシュするコミットはありません"
                  : "初回プッシュ（upstream を設定）"
          }
          onClick={() => void push()}
        >
          <CloudUpload className="h-3.5 w-3.5" />
          Push
          {branches?.ahead && branches.ahead > 0 ? ` (${branches.ahead})` : ""}
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
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Inline action panels */}
      {panel === "commit" && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-2 sm:flex-row sm:items-center">
          <input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            disabled={generatingCommitMessage || busy}
            aria-label="コミットメッセージ"
            placeholder="コミットメッセージ"
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                commitMsg.trim() &&
                selectedPaths.length > 0 &&
                payload
              ) {
                void commit();
              }
            }}
          />
          {commitModel && (
            <span
              className="min-w-0 truncate text-xs text-muted"
              title={`生成モデル: ${directGenerationModelKey(commitModel)}`}
            >
              生成モデル: <span className="font-mono">{commitModel.modelID}</span>
            </span>
          )}
          <Button
            variant="ghost"
            size="md"
            className="w-full shrink-0 sm:w-auto"
            busy={generatingCommitMessage}
            disabled={busy || selectedPaths.length === 0}
            title="選択したファイルからメッセージ案を生成"
            onClick={async () => {
              if (generatingCommitMessage || busy) return;
              const selectedFiles = files.filter((f) => !deselected[f.path]);
              setGeneratingCommitMessage(true);
              setError(null);
              try {
                const result = await sendJson<{ message: string; warning?: string; model?: unknown }>(
                  "/api/git/commit-message",
                  { directory, files: selectedFiles, ...(model ? { model } : {}) },
                  "POST",
                );
                setCommitMsg(result.message);
                setCommitModel(parseDirectGenerationModelResponse(result) ?? null);
                setError(result.warning ?? null);
              } catch (error) {
                setCommitModel(null);
                setCommitMsg(
                  suggestCommitMessage(
                    selectedFiles.map((f) => ({ path: f.path, untracked: f.untracked })),
                  ),
                );
                setError(error instanceof Error ? error.message : "コミットメッセージの生成に失敗しました");
              } finally {
                if (mountedRef.current) setGeneratingCommitMessage(false);
              }
            }}
          >
            {generatingCommitMessage ? "生成中…" : "生成"}
          </Button>
          {generatingCommitMessage && (
            <span role="status" aria-live="polite" className="text-xs text-muted">
              コミットメッセージを生成中…
            </span>
          )}
          <Button
            variant="primary"
            size="md"
            className="w-full shrink-0 sm:w-auto"
            busy={busy}
            disabled={generatingCommitMessage || !commitMsg.trim() || selectedPaths.length === 0}
            onClick={() => void commit()}
          >
            コミット ({selectedPaths.length})
          </Button>
        </div>
      )}
      {panel === "merge" && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <span className="font-mono text-xs text-muted">
            {branches?.current ?? "?"}
          </span>
          <select
            value={mergeTarget}
            onChange={(e) => setMergeTarget(e.target.value)}
            aria-label="マージ先ブランチ"
            className="h-9 min-w-32 flex-1 cursor-pointer rounded-lg border border-border bg-bg px-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
          >
            <option value="">ブランチを選択</option>
            {(branches?.branches ?? [])
              .filter((b) => b !== branches?.current)
              .map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            busy={busy}
            disabled={!mergeTarget || hasChanges}
            title={hasChanges ? "先にコミットしてください" : `${mergeTarget} を現在のブランチへ取り込む`}
            onClick={() => void merge("current")}
          >
            取り込む ←
          </Button>
          <Button
            size="sm"
            busy={busy}
            disabled={!mergeTarget || hasChanges}
            title={hasChanges ? "先にコミットしてください" : `現在のブランチを ${mergeTarget} へマージ`}
            onClick={() => void merge("branch")}
          >
            → 反映する
          </Button>
        </div>
      )}
      {panel === "pr" && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-2 sm:flex-row sm:items-center">
          <input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            aria-label="PR タイトル"
            placeholder="PR タイトル"
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong"
          />
          <Button
            variant="primary"
            size="md"
            className="w-full shrink-0 sm:w-auto"
            busy={busy}
            disabled={!prTitle.trim() || hasChanges}
            title={hasChanges ? "先にコミットしてください" : undefined}
            onClick={() => void createPr()}
          >
            PR 作成
          </Button>
        </div>
      )}

      {(notice || error) && (
        <div
          className={cx(
            "shrink-0 border-b px-3 py-2 text-xs break-all",
            error
              ? "border-danger/30 bg-danger-bg text-danger"
              : "border-success/30 bg-success-bg text-success",
          )}
          role={error ? "alert" : "status"}
          aria-live={error ? "assertive" : "polite"}
        >
          {error ?? (
            <span className="inline-flex items-center gap-1">
              {notice}
              {notice?.includes("http") && (
                <a
                  href={/https?:\/\/\S+/.exec(notice)?.[0]}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center underline"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </span>
          )}
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
        {payload && !payload.git &&
          (payload.error && !/not a git repository/.test(payload.error) ? (
            <p className="py-10 text-center text-sm text-faint">
              {payload.error}
            </p>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-faint" role="status" aria-live="polite">
                このディレクトリは Git リポジトリではありません。初期化して変更管理を始められます。
              </p>
              <Button
                variant="secondary"
                size="sm"
                busy={busy}
                onClick={() => void initializeRepo()}
              >
                <GitBranch className="h-3.5 w-3.5" />
                Git リポジトリを初期化
              </Button>
            </div>
          ))}
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
            selected={!deselected[f.path]}
            sideBySide={sideBySide}
            busy={busy}
            onToggle={toggleFile}
            onSelect={selectFile}
            onDelete={deleteFile}
          />
        ))}
      </div>
    </div>
  );
}
