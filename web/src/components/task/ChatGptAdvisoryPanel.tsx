"use client";

import { useState } from "react";
import { Badge, Button } from "@/components/ui";
import { sendJson } from "@/lib/client";
import type {
  ChatGptAdvisoryImportKind,
  ChatGptAdvisoryMessage,
  ChatGptAdvisoryMessageKind,
  ChatGptExecutionRecord,
  ChatGptExitStatus,
} from "@/lib/chatgpt-bridge";
import {
  advisoryImportLabel,
  advisoryMessageLabel,
  CHATGPT_EXTERNAL_GUARD,
  exitStatusLabel,
  guardedAdvisoryPrompt,
  readChatGptAdvisorySnapshot,
  type ChatGptAdvisorySnapshot,
  writeChatGptAdvisorySnapshot,
} from "@/lib/chatgpt-advisory";

const ADVISORY_STATE_LABELS: Record<ChatGptAdvisorySnapshot["state"], string> = {
  ready_to_copy: "依頼を準備できます",
  waiting_for_user: "ChatGPTの応答待ち",
  proposal_received: "提案を受信しました",
  recorded: "実行結果を記録済み",
};

function advisoryTone(state: ChatGptAdvisorySnapshot["state"]): "neutral" | "working" | "success" | "warning" {
  if (state === "waiting_for_user") return "working";
  if (state === "proposal_received" || state === "recorded") return "success";
  return "neutral";
}

export function ChatGptAdvisoryPanel({
  taskId,
  projectId,
  taskTitle,
}: {
  taskId: string;
  projectId: string;
  taskTitle: string;
}) {
  const [snapshot, setSnapshot] = useState<ChatGptAdvisorySnapshot>(() => readChatGptAdvisorySnapshot(taskId));
  const [goal, setGoal] = useState(taskTitle);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<ChatGptAdvisoryMessageKind | null>(null);
  const [externalContent, setExternalContent] = useState("");
  const [importKind, setImportKind] = useState<ChatGptAdvisoryImportKind>("plan");
  const [tests, setTests] = useState("");
  const [exitStatus, setExitStatus] = useState<ChatGptExitStatus>("ok");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateSnapshot(patch: Partial<ChatGptAdvisorySnapshot>) {
    setSnapshot((current) => {
      const next = { ...current, ...patch };
      writeChatGptAdvisorySnapshot(taskId, next);
      return next;
    });
  }

  async function generate(kind: ChatGptAdvisoryMessageKind) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const result = await sendJson<ChatGptAdvisoryMessage>("/api/chatgpt-bridge/message", {
        projectId,
        publicTaskId: snapshot.publicTaskId,
        iteration: snapshot.iteration,
        kind,
        ...(kind === "init" ? { goal } : {}),
      });
      setMessage(result.message);
      setMessageKind(kind);
      updateSnapshot({ state: "ready_to_copy" });
      setNotice(`${advisoryMessageLabel(kind)}を生成しました`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${advisoryMessageLabel(kind)}の生成に失敗しました`);
    } finally {
      setBusy(null);
    }
  }

  async function copyMessage() {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      updateSnapshot({ state: "waiting_for_user" });
      setNotice(`${messageKind ? advisoryMessageLabel(messageKind) : "メッセージ"}をコピーしました。ChatGPTへ貼り付けてください`);
      setError(null);
    } catch {
      setError("メッセージのコピーに失敗しました");
    }
  }

  async function recordExecution() {
    setBusy("record");
    setError(null);
    setNotice(null);
    try {
      const result = await sendJson<ChatGptExecutionRecord>("/api/chatgpt-bridge/record", {
        projectId,
        publicTaskId: snapshot.publicTaskId,
        iteration: snapshot.iteration,
        tests: tests.trim() || null,
        exitStatus,
      });
      updateSnapshot({ state: "recorded" });
      setNotice(`実行結果を記録しました（変更ファイル${result.changedFiles}件）`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "実行結果の記録に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function importProposal() {
    const content = externalContent.trim();
    if (!content) {
      setError("PLANまたはREVIEWを入力してください");
      return;
    }
    setBusy("import");
    setError(null);
    setNotice(null);
    try {
      await sendJson(`/api/tasks/${encodeURIComponent(taskId)}/prompt`, {
        prompt: guardedAdvisoryPrompt(importKind, content),
      });
      updateSnapshot({ state: "proposal_received" });
      setNotice(`${advisoryImportLabel(importKind)}を未検証の提案としてPiへ送信しました。自動実行はしていません`);
      setExternalContent("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "外部提案の取り込みに失敗しました");
    } finally {
      setBusy(null);
    }
  }

  function nextIteration() {
    updateSnapshot({ iteration: snapshot.iteration + 1, state: "ready_to_copy" });
    setMessage("");
    setMessageKind(null);
    setNotice(`iteration ${snapshot.iteration + 1} の準備ができました`);
    setError(null);
  }

  return (
    <section aria-labelledby="chatgpt-advisory-heading" className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="chatgpt-advisory-heading" className="text-sm font-semibold">ChatGPTアドバイザー</h2>
          <p className="mt-1 text-xs text-muted">
            外部サブエージェント相当の読み取り専用相談です。Piの子Sessionや実行権限は共有しません。
          </p>
        </div>
        <Badge tone={advisoryTone(snapshot.state)}>{ADVISORY_STATE_LABELS[snapshot.state]}</Badge>
      </div>

      <dl className="mt-3 grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1 text-xs">
        <dt className="text-muted">外部ID</dt>
        <dd className="min-w-0 break-all font-mono">{snapshot.publicTaskId}</dd>
        <dt className="text-muted">iteration</dt>
        <dd>{snapshot.iteration}</dd>
      </dl>

      <label className="mt-4 block">
        <span className="text-xs font-medium text-muted">INITの目標（コピー前に確認・編集）</span>
        <textarea
          value={goal}
          maxLength={600}
          onChange={(event) => setGoal(event.target.value)}
          className="mt-1 min-h-20 w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-border-strong"
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" className="min-h-11" busy={busy === "init"} disabled={busy !== null} onClick={() => void generate("init")}>
          INITを生成
        </Button>
        <Button variant="secondary" className="min-h-11" busy={busy === "executed"} disabled={busy !== null} onClick={() => void generate("executed")}>
          EXECUTEDを生成
        </Button>
        <Button variant="ghost" className="min-h-11" disabled={busy !== null || !message} onClick={() => void copyMessage()}>
          メッセージをコピー
        </Button>
        <Button variant="ghost" className="min-h-11" disabled={busy !== null} onClick={nextIteration}>
          次のiteration
        </Button>
      </div>

      {message && (
        <div className="mt-3 rounded-xl border border-border bg-surface-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-text">{messageKind ? advisoryMessageLabel(messageKind) : "C2C"}</p>
            <span className="text-[11px] text-muted">1KB以内</span>
          </div>
          <textarea readOnly value={message} aria-label="ChatGPTへ貼り付けるメッセージ" className="mt-1 min-h-36 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text outline-none" />
        </div>
      )}

      <details className="mt-4 rounded-xl border border-border bg-surface-2 px-3 py-2">
        <summary className="cursor-pointer select-none text-xs font-medium text-muted">実行結果を記録</summary>
        <div className="mt-3 space-y-3">
          <label className="block text-xs text-muted">
            テスト要約（任意）
            <input value={tests} maxLength={1_000} onChange={(event) => setTests(event.target.value)} placeholder="例: 80 passed" className="mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text outline-none focus:border-border-strong" />
          </label>
          <label className="block text-xs text-muted">
            終了状態
            <select value={exitStatus} onChange={(event) => setExitStatus(event.target.value as ChatGptExitStatus)} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text outline-none focus:border-border-strong">
              {(["ok", "failed", "blocked"] as const).map((value) => <option key={value} value={value}>{exitStatusLabel(value)}</option>)}
            </select>
          </label>
          <Button variant="secondary" className="min-h-11" busy={busy === "record"} disabled={busy !== null} onClick={() => void recordExecution()}>
            実行結果を記録
          </Button>
        </div>
      </details>

      <details className="mt-3 rounded-xl border border-border bg-surface-2 px-3 py-2">
        <summary className="cursor-pointer select-none text-xs font-medium text-muted">PLAN / REVIEWを取り込む</summary>
        <div className="mt-3 space-y-3">
          <p className="text-[11px] text-muted">{CHATGPT_EXTERNAL_GUARD}</p>
          <label className="block text-xs text-muted">
            種別
            <select value={importKind} onChange={(event) => setImportKind(event.target.value as ChatGptAdvisoryImportKind)} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text outline-none focus:border-border-strong">
              {(["plan", "review", "done", "blocked"] as const).map((value) => <option key={value} value={value}>{advisoryImportLabel(value)}</option>)}
            </select>
          </label>
          <textarea
            value={externalContent}
            maxLength={32_000}
            onChange={(event) => setExternalContent(event.target.value)}
            placeholder="ChatGPTの提案を貼り付け"
            aria-label="ChatGPTの外部提案"
            className="min-h-36 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-border-strong"
          />
          <Button variant="secondary" className="min-h-11" busy={busy === "import"} disabled={busy !== null || !externalContent.trim()} onClick={() => void importProposal()}>
            未検証の提案としてPiへ送信
          </Button>
        </div>
      </details>

      {notice && <p className="mt-3 text-sm text-success" role="status">{notice}</p>}
      {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
    </section>
  );
}
