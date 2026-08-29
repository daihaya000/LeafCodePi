"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import type { ProjectDto } from "@/lib/types";
import { isSafeChatGptProjectId } from "@/lib/chatgpt-bridge";

const ADVISOR_STATES = [
  "disabled",
  "prerequisites_missing",
  "setup_required",
  "ready",
  "running",
  "degraded",
  "error",
] as const;

type AdvisorState = (typeof ADVISOR_STATES)[number];

const ADVISOR_STATE_SET: ReadonlySet<AdvisorState> = new Set(ADVISOR_STATES);

interface AdvisorStatus {
  ok: boolean;
  enabled: boolean;
  artifactReady: boolean;
  chromeAvailable: boolean;
  ready: boolean;
  state: AdvisorState;
  projectId?: string | null;
  projectName?: string;
  extensionId?: string | null;
  chromePid?: number | null;
  hostPid?: number | null;
  profileDir?: string;
  error?: string;
}

const STATE_LABELS: Record<AdvisorState, string> = {
  disabled: "無効",
  prerequisites_missing: "前提未充足",
  setup_required: "セットアップが必要",
  ready: "準備完了",
  running: "実行中",
  degraded: "一部停止",
  error: "エラー",
};

function stateTone(state: AdvisorState): "neutral" | "working" | "success" | "warning" | "danger" {
  if (state === "ready") return "success";
  if (state === "running" || state === "setup_required") return "working";
  if (state === "degraded" || state === "prerequisites_missing") return "warning";
  if (state === "error") return "danger";
  return "neutral";
}

export function ChatGptAdvisorSettings() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<AdvisorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshStatus = useCallback(async (nextProjectId: string) => {
    setStatus(null);
    if (!nextProjectId) return;
    try {
      const next = await getJson<AdvisorStatus>("/api/chatgpt-advisor", { projectId: nextProjectId });
      setStatus(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ChatGPTアドバイザーの状態取得に失敗しました");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getJson<{ projects: ProjectDto[] }>("/api/projects")
      .then((result) => {
        if (cancelled) return;
        const available = result.projects.filter((project) => !project.archived);
        setProjects(available);
        const nextProjectId = available[0]?.id ?? "";
        setProjectId(nextProjectId);
        if (nextProjectId) void refreshStatus(nextProjectId);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Project一覧の取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projectId, projects],
  );

  async function runAction(action: "setup" | "open" | "verify" | "stop" | "cleanup") {
    if (action === "setup" && !isSafeChatGptProjectId(projectId)) {
      setError("対象Projectを選択してください");
      return;
    }
    if (action === "cleanup" && typeof window !== "undefined" && !window.confirm("ChatGPTアドバイザーのプロファイルを削除しますか？")) return;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const body = action === "setup" ? { projectId } : action === "cleanup" ? { deleteProfile: true } : {};
      const next = await sendJson<AdvisorStatus>(`/api/chatgpt-advisor/${action}`, body);
      setStatus(next);
      if (action === "open") setNotice("専用ブラウザを開きました。ChatGPTにログインしてください");
      else if (action === "stop") setNotice("ChatGPTアドバイザーを停止しました");
      else if (action === "setup" && next.ready) setNotice("ChatGPTアドバイザーの準備ができました");
      else if (action === "setup") setNotice("セットアップ中です。専用ブラウザでChatGPTにログインしてください");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ChatGPTアドバイザーの操作に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled() {
    const enabled = !(status?.enabled ?? false);
    setBusy("enabled");
    setError(null);
    setNotice(null);
    try {
      const next = await sendJson<{ ok: boolean; enabled: boolean }>("/api/chatgpt-advisor/enabled", { enabled });
      setStatus((current) => current ? { ...current, enabled: next.enabled, state: next.enabled ? "setup_required" : "disabled" } : current);
      setNotice(next.enabled ? "ChatGPTアドバイザーを有効にしました" : "ChatGPTアドバイザーを無効にしました");
      if (projectId) await refreshStatus(projectId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ChatGPTアドバイザーの切替に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  const state = (status?.state && ADVISOR_STATE_SET.has(status.state) ? status.state : null) ?? (loading ? "disabled" : "setup_required");
  const canOperate = Boolean(projectId) && status?.enabled === true && !loading;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">ChatGPT自動アドバイザー</h2>
          <p className="mt-1 text-xs text-muted">
            Piが必要な時にChatGPTを呼び出し、計画・レビューを読み取り専用で受け取ります。編集・コマンド・Git操作はPiが担当します。
          </p>
        </div>
        <Badge tone={stateTone(state)} pulse={state === "running"}>
          {STATE_LABELS[state]}
        </Badge>
      </div>

      <div className="mt-4 space-y-3">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm text-muted">対象Project</span>
          <select
            value={projectId}
            aria-label="ChatGPTアドバイザーの対象Project"
            disabled={loading || projects.length === 0 || busy !== null}
            onChange={(event) => {
              const nextProjectId = event.target.value;
              setProjectId(nextProjectId);
              setStatus(null);
              setError(null);
              setNotice(null);
              void refreshStatus(nextProjectId);
            }}
            className="min-h-11 min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-40"
          >
            {projects.length === 0 && <option value="">登録済みProjectがありません</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>

        <dl className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-y-2 text-xs">
          <dt className="text-muted">Surf fork</dt>
          <dd>{status?.artifactReady ? "利用可能" : "未導入"}</dd>
          <dt className="text-muted">Chrome</dt>
          <dd>{status?.chromeAvailable ? "利用可能" : "未検出"}</dd>
          <dt className="text-muted">拡張ID</dt>
          <dd className="min-w-0 break-all font-mono">{status?.extensionId ?? "—"}</dd>
          {status?.profileDir && (
            <>
              <dt className="text-muted">専用プロファイル</dt>
              <dd className="min-w-0 break-all">{status.profileDir}</dd>
            </>
          )}
        </dl>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={status?.enabled === true}
            aria-label="ChatGPT自動アドバイザーを有効にする"
            disabled={busy !== null || loading || status === null}
            onClick={() => void toggleEnabled()}
            className={cx(
              "relative min-h-11 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              status?.enabled ? "bg-primary" : "bg-surface-3",
            )}
          >
            <span className={cx("absolute top-1 left-1 h-9 w-9 rounded-full bg-surface shadow transition-transform", status?.enabled && "translate-x-1")}/>
          </button>
          <Button
            variant="primary"
            className="min-h-11"
            disabled={!canOperate || busy !== null}
            busy={busy === "setup"}
            onClick={() => void runAction("setup")}
          >
            セットアップを開始
          </Button>
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={!canOperate || busy !== null}
            busy={busy === "open"}
            onClick={() => void runAction("open")}
          >
            専用ブラウザを開く
          </Button>
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={!canOperate || busy !== null}
            busy={busy === "verify"}
            onClick={() => void runAction("verify")}
          >
            接続を確認
          </Button>
          <Button
            variant="danger"
            className="min-h-11"
            disabled={!projectId || busy !== null || status?.state === "disabled"}
            busy={busy === "stop"}
            onClick={() => void runAction("stop")}
          >
            停止
          </Button>
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={busy !== null || status?.state === "disabled"}
            busy={busy === "cleanup"}
            onClick={() => void runAction("cleanup")}
          >
            データ削除
          </Button>
          <Button variant="ghost" className="min-h-11" disabled={busy !== null || !projectId} onClick={() => void refreshStatus(projectId)}>
            再読込
          </Button>
        </div>

        <p className="text-xs text-muted" aria-live="polite">
          {notice ? <span className="text-success">{notice}</span> : null}
          {error ? <span className="text-danger" role="alert">{error}</span> : null}
        </p>
        {!selectedProject && !loading && <p className="text-xs text-muted">Projectを登録するとChatGPT自動アドバイザーを設定できます。</p>}
      </div>
    </div>
  );
}
