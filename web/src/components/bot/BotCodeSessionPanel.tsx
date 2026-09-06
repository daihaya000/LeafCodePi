"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import type { ProjectDto, TaskSummary } from "@/lib/types";

function statusLabel(status: TaskSummary["status"]): string {
  if (status === "working") return "実行中";
  if (status === "error") return "エラー";
  if (status === "archived") return "アーカイブ済み";
  return "待機中";
}

export function BotCodeSessionPanel({ botId }: { botId: string }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState("");
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [prompt, setPrompt] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [session, projectResult] = await Promise.all([
        getJson<{ task: TaskSummary | null }>(`/api/bots/${encodeURIComponent(botId)}/code-session`),
        getJson<{ projects: ProjectDto[] }>("/api/projects"),
      ]);
      setTask(session.task);
      setProjects(projectResult.projects.filter((project) => !project.archived));
      setProjectId((current) => current || projectResult.projects.find((project) => !project.archived)?.id || "");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Codeセッションを読み込めませんでした");
    }
  }, [botId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (task?.status !== "working") return;
    const timer = window.setInterval(() => { void load(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [load, task?.status]);

  const launch = async () => {
    if (!projectId || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ task: TaskSummary }>(
        `/api/bots/${encodeURIComponent(botId)}/code-session`,
        { projectId, prompt: prompt.trim() },
        "POST",
      );
      setTask(result.task);
      setPrompt("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Codeセッションの起動に失敗しました");
    } finally { setBusy(false); }
  };

  const control = async (action: "abort" | "prompt", value?: string) => {
    if (controlBusy || !task) return;
    setControlBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ task: TaskSummary }>(
        `/api/bots/${encodeURIComponent(botId)}/code-session`,
        action === "prompt" ? { action, prompt: value?.trim() } : { action },
        "PATCH",
      );
      setTask(result.task);
      if (action === "prompt") setFollowUp("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Codeセッションの操作に失敗しました");
    } finally { setControlBusy(false); }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="Codeセッション">
      <div>
        <h3 className="text-sm font-medium">Codeセッション</h3>
        <p className="mt-1 text-xs text-muted">Botから既存のCodeタスクを1件だけ起動・監視します。</p>
      </div>
      {task ? (
        <div className="rounded-xl border border-border bg-surface p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{statusLabel(task.status)}</span>
            <Link className="text-accent hover:underline" href={`/task/${encodeURIComponent(task.id)}`}>Codeを開く</Link>
          </div>
          <p className="mt-1 truncate text-muted" title={task.title}>{task.title}</p>
          {task.status !== "archived" && (
            <div className="mt-3 space-y-2">
              <textarea value={followUp} onChange={(event) => setFollowUp(event.target.value)} rows={2} placeholder="続きの指示（任意）" className="w-full resize-y rounded-lg border border-border bg-bg px-2 py-1.5 text-xs" />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={controlBusy || !followUp.trim()} onClick={() => void control("prompt", followUp)}>指示を送る</Button>
                <Button size="sm" variant="danger" disabled={controlBusy || task.status !== "working"} onClick={() => void control("abort")}>停止</Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm" aria-label="Codeプロジェクト">
            <option value="">プロジェクトを選択</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="Codeに実行させる指示" className="w-full resize-y rounded-lg border border-border bg-surface px-2 py-1.5 text-xs" />
          <div className="flex justify-end"><Button size="sm" onClick={() => void launch()} busy={busy} disabled={!projectId || !prompt.trim()}>Codeを起動</Button></div>
        </>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </section>
  );
}