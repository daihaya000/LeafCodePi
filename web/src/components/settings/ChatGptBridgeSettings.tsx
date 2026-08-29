"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import type { ProjectDto } from "@/lib/types";
import {
  isSafeChatGptConversationUrl,
  type ChatGptBridgePairing,
  type ChatGptBridgeStatus,
} from "@/lib/chatgpt-bridge";

const STATE_LABELS: Record<ChatGptBridgeStatus["state"], string> = {
  disabled: "無効",
  prerequisites_missing: "前提未充足",
  ready: "準備完了",
  starting: "起動中",
  pairing: "配布コード待ち",
  connected: "接続済み",
  verified: "読取確認済み",
  repair_needed: "修復が必要",
  busy: "別Projectが使用中",
  error: "エラー",
};

function stateTone(state: ChatGptBridgeStatus["state"]): "neutral" | "working" | "success" | "warning" | "danger" {
  if (state === "verified" || state === "connected") return "success";
  if (state === "starting" || state === "pairing") return "working";
  if (state === "repair_needed" || state === "prerequisites_missing" || state === "busy") return "warning";
  if (state === "error") return "danger";
  return "neutral";
}

function formatExpiry(seconds: number): string {
  if (seconds <= 0) return "失効済み";
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `残り約${minutes}分` : `残り${seconds}秒`;
}

export function ChatGptBridgeSettings() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<ChatGptBridgeStatus | null>(null);
  const [conversationUrl, setConversationUrl] = useState("");
  const [pairing, setPairing] = useState<ChatGptBridgePairing | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshStatus = useCallback(async (nextProjectId: string, keepPairing = false) => {
    setStatus(null);
    if (!nextProjectId) {
      setStatus(null);
      return;
    }
    try {
      const next = await getJson<ChatGptBridgeStatus>("/api/chatgpt-bridge", { projectId: nextProjectId });
      setStatus(next);
      setConversationUrl(next.conversationUrl ?? "");
      if (!keepPairing && next.state !== "pairing") setPairing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ChatGPT連携の状態取得に失敗しました");
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
        else setStatus(null);
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

  useEffect(() => {
    if (!pairing) return;
    const update = () => setRemainingSeconds(Math.max(0, Math.ceil((pairing.pairingExpiresAt - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projectId, projects],
  );

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label}をコピーしました`);
      setError(null);
    } catch {
      setError(`${label}のコピーに失敗しました`);
    }
  }

  async function runAction(action: "setup" | "start" | "verify" | "stop" | "disconnect") {
    if (!projectId) return;
    if (action === "disconnect" && typeof window !== "undefined" && !window.confirm("ChatGPT連携を解除しますか？")) return;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const next = await sendJson<ChatGptBridgeStatus>(`/api/chatgpt-bridge/${action}`, { projectId });
      setStatus(next);
      if (action === "disconnect") setPairing(null);
      else if (next.state !== "pairing") setPairing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ChatGPT連携の操作に失敗しました");
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
      const next = await sendJson<{ ok: boolean; enabled: boolean }>("/api/chatgpt-bridge/enabled", { enabled });
      setStatus((current) => current ? { ...current, enabled: next.enabled, state: next.enabled ? "ready" : "disabled" } : current);
      setNotice(next.enabled ? "ChatGPT連携を有効にしました" : "ChatGPT連携を無効にしました");
      if (projectId) await refreshStatus(projectId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ChatGPT連携の切替に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function saveConversation() {
    if (!projectId) return;
    const value = conversationUrl.trim();
    if (value && !isSafeChatGptConversationUrl(value)) {
      setError("ChatGPTの会話URLを入力してください");
      return;
    }
    setBusy("session");
    setError(null);
    setNotice(null);
    try {
      const next = await sendJson<{ ok: boolean; projectId: string; conversationUrl: string | null }>(
        "/api/chatgpt-bridge/session",
        { projectId, conversationUrl: value || null },
        "PATCH",
      );
      setConversationUrl(next.conversationUrl ?? "");
      setStatus((current) => current ? { ...current, conversationUrl: next.conversationUrl } : current);
      setNotice("会話URLを保存しました");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "会話URLの保存に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function pairBridge() {
    if (!projectId) return;
    setBusy("pair");
    setError(null);
    setNotice(null);
    try {
      const next = await sendJson<ChatGptBridgePairing>("/api/chatgpt-bridge/pair", { projectId });
      setPairing(next);
      setNotice("配布コードを発行しました。ChatGPTのConnector設定で認証してください");
      await refreshStatus(projectId, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "配布コードの発行に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  const state = status?.state ?? (loading ? "starting" : "disabled");
  const canOperate = Boolean(projectId) && status?.enabled === true && !loading;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">ChatGPTプラン・レビュー連携</h2>
          <p className="mt-1 text-xs text-muted">
            ChatGPTは読み取り専用の外部アドバイザーです。編集・コマンド・テスト・Git操作はPiが担当します。
          </p>
        </div>
        <Badge tone={stateTone(state)} pulse={state === "starting"}>
          {STATE_LABELS[state]}
        </Badge>
      </div>

      <div className="mt-4 space-y-3">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm text-muted">対象Project</span>
          <select
            value={projectId}
            aria-label="ChatGPT連携の対象Project"
            disabled={loading || projects.length === 0 || busy !== null}
            onChange={(event) => {
              const nextProjectId = event.target.value;
              setProjectId(nextProjectId);
              setPairing(null);
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
          <dt className="text-muted">Bridge artifact</dt>
          <dd>{status?.artifactReady ? "利用可能" : "未導入"}</dd>
          <dt className="text-muted">cloudflared</dt>
          <dd>{status?.cloudflaredAvailable ? "利用可能" : "未導入"}</dd>
          <dt className="text-muted">Connector</dt>
          <dd className="min-w-0 break-all font-mono">{pairing?.connectionUrl ?? status?.connectionUrl ?? "—"}</dd>
          {status?.verifiedAt && (
            <>
              <dt className="text-muted">読取確認</dt>
              <dd>{new Date(status.verifiedAt).toLocaleString()}</dd>
            </>
          )}
        </dl>

        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-muted">
            ChatGPT会話URL（任意）
            <input
              type="url"
              value={conversationUrl}
              onChange={(event) => setConversationUrl(event.target.value)}
              placeholder="https://chatgpt.com/c/..."
              className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none focus:border-border-strong"
            />
          </label>
          <Button variant="secondary" className="min-h-11" busy={busy === "session"} disabled={!projectId || busy !== null} onClick={() => void saveConversation()}>
            URLを保存
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={status?.enabled === true}
            aria-label="ChatGPT連携を有効にする"
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
            接続を開始
          </Button>
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={!canOperate || busy !== null || status?.tunnelRunning !== true}
            busy={busy === "pair"}
            onClick={() => void pairBridge()}
          >
            配布コードを発行
          </Button>
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={!canOperate || busy !== null || status?.connected !== true}
            busy={busy === "verify"}
            onClick={() => void runAction("verify")}
          >
            読取確認
          </Button>
          <Button
            variant="danger"
            className="min-h-11"
            disabled={!projectId || busy !== null || status?.state === "disabled" || status?.state === "ready"}
            busy={busy === "disconnect"}
            onClick={() => void runAction("disconnect")}
          >
            接続解除
          </Button>
          <Button variant="ghost" className="min-h-11" disabled={busy !== null || !projectId} onClick={() => void refreshStatus(projectId)}>
            再読込
          </Button>
        </div>

        {pairing && (
          <div className="rounded-xl border border-border bg-surface-2 p-3" aria-live="polite">
            <p className="text-xs font-medium text-text">Connector URL</p>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-xs">{pairing.connectionUrl}</code>
              <Button size="md" className="min-h-11" onClick={() => void copy(pairing.connectionUrl, "Connector URL")}>コピー</Button>
            </div>
            <p className="mt-3 text-xs font-medium text-text">配布コード</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="rounded-lg bg-surface px-3 py-2 font-mono text-lg tracking-[0.2em]">{pairing.pairingCode}</code>
              <Button size="md" className="min-h-11" onClick={() => void copy(pairing.pairingCode, "配布コード")}>コピー</Button>
              <span className="text-xs text-muted">{formatExpiry(remainingSeconds)}</span>
            </div>
          </div>
        )}

        {notice && <p className="text-sm text-success" role="status">{notice}</p>}
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        {!selectedProject && !loading && <p className="text-xs text-muted">Projectを登録するとChatGPT連携を設定できます。</p>}
      </div>
    </div>
  );
}
