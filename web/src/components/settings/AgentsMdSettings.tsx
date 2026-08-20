"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type AgentsMd = { path: string; exists: boolean; content: string };
type SaveResult = AgentsMd & {
  ok: boolean;
  reload?: { reloaded: number; failed: number; errors: string[] };
};
type LoadState = "loading" | "ready" | "error";

export function AgentsMdSettings() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [meta, setMeta] = useState<AgentsMd | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getJson<AgentsMd>("/api/agents-md");
      if (!mountedRef.current) return;
      setMeta(data);
      setContent(data.content);
      setLoadState("ready");
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "AGENTS.mdの読み込みに失敗しました");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await sendJson<SaveResult>("/api/agents-md", { content }, "PATCH");
      if (!mountedRef.current) return;
      setMeta({ path: saved.path, exists: saved.exists, content: saved.content });
      const reload = saved.reload;
      if (reload && reload.failed > 0) {
        setMessage(
          `保存しました。${reload.reloaded} 件のセッションに反映、${reload.failed} 件は失敗しました。`,
        );
        if (reload.errors[0]) setError(reload.errors[0]);
      } else if (reload && reload.reloaded > 0) {
        setMessage(`保存し、開いている ${reload.reloaded} 件のセッションへ即時反映しました。`);
      } else {
        setMessage("保存しました。次に開くセッションから有効です。");
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "AGENTS.mdの保存に失敗しました");
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">カスタム指示（AGENTS.md）</h2>
          <p className="mt-1 text-xs text-muted">
            全プロジェクト共通の指示です。Pi は <span className="font-mono">~/.pi/agent/AGENTS.md</span>{" "}
            を読み込みます。保存すると開いているセッションにも即時反映され（進行中の応答の次のターンから）。
          </p>
        </div>
        {meta && (
          <Badge tone={meta.exists ? "success" : "neutral"}>
            {meta.exists ? "存在" : "新規作成"}
          </Badge>
        )}
      </div>

      {meta?.path && (
        <p className="mb-2 truncate font-mono text-[11px] text-faint" title={meta.path}>
          {meta.path}
        </p>
      )}

      {loadState === "loading" && <p className="text-xs text-faint">読み込み中…</p>}

      {(loadState === "ready" || loadState === "error") && (
        <>
          <textarea
            aria-label="グローバル AGENTS.md"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={14}
            spellCheck={false}
            disabled={loadState === "error" && !meta}
            className="w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-xs leading-5 text-text outline-none focus:border-accent disabled:opacity-50"
            placeholder={"# カスタム指示\n\n- 簡潔に答える\n- …"}
          />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => void refresh()}>
              再読み込み
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              busy={saving}
              disabled={loadState === "error" && !meta}
              onClick={() => void save()}
            >
              AGENTS.md を保存
            </Button>
          </div>
        </>
      )}

      {error && (
        <p className="mt-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p
          className="mt-2 rounded-lg border border-success/30 bg-success-bg px-3 py-2 text-xs text-success"
          role="status"
        >
          {message}
        </p>
      )}
    </div>
  );
}
