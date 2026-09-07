"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type InstructionsMd = { path: string; exists: boolean; content: string };
type SaveResult = InstructionsMd & {
  ok: boolean;
  reload?: { reloaded: number; failed: number; errors: string[] };
};
type LoadState = "loading" | "ready" | "error";

export type InstructionsMdSettingsProps = {
  /** File name shown in labels and messages, e.g. `AGENTS.md`. */
  fileName: string;
  title: string;
  description: ReactNode;
  /** API route serving GET / PATCH for this file. */
  endpoint: string;
  placeholder: string;
};

/** Markdown viewer/editor for a single global instruction file. */
export function InstructionsMdSettings({
  fileName,
  title,
  description,
  endpoint,
  placeholder,
}: InstructionsMdSettingsProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [meta, setMeta] = useState<InstructionsMd | null>(null);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getJson<InstructionsMd>(endpoint);
      if (!mountedRef.current) return;
      setMeta(data);
      setContent(data.content ?? "");
      setEditing(false);
      setLoadState("ready");
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : `${fileName}の読み込みに失敗しました`);
      setLoadState("error");
    }
  }, [endpoint, fileName]);

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
      const saved = await sendJson<SaveResult>(endpoint, { content }, "PATCH");
      if (!mountedRef.current) return;
      setMeta({ path: saved.path, exists: saved.exists, content: saved.content });
      setContent(saved.content);
      setEditing(false);
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
        setError(err instanceof Error ? err.message : `${fileName}の保存に失敗しました`);
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs text-muted">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {meta && (
            <Badge tone={meta.exists ? "success" : "neutral"}>
              {meta.exists ? "存在" : "新規作成"}
            </Badge>
          )}
          {loadState === "ready" && !editing && (
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
              編集
            </Button>
          )}
        </div>
      </div>

      {meta?.path && (
        <p className="mb-2 truncate font-mono text-[11px] text-muted" title={meta.path}>
          {meta.path}
        </p>
      )}

      {loadState === "loading" && <p className="text-xs text-muted">読み込み中…</p>}

      {loadState === "ready" && !editing && (
        content.trim() ? (
          <div className="md rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-muted">{fileName} は空です。</p>
        )
      )}

      {(editing || loadState === "error") && (
        <>
          <textarea
            aria-label={`グローバル ${fileName}`}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={14}
            spellCheck={false}
            disabled={loadState === "error" && !meta}
            className="w-full resize-none overflow-hidden rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-xs leading-5 text-text outline-none [field-sizing:content] focus:border-accent disabled:opacity-50"
            placeholder={placeholder}
          />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={() => void refresh()}>
              再読み込み
            </Button>
            {editing && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setContent(meta?.content ?? "");
                  setEditing(false);
                }}
              >
                キャンセル
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="primary"
              busy={saving}
              disabled={loadState === "error" && !meta}
              onClick={() => void save()}
            >
              {fileName} を保存
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
