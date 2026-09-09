"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { NO_PROJECT_NAME, type ProjectDto, type TaskSummary } from "@/lib/types";

function statusLabel(status: TaskSummary["status"]): string {
  if (status === "working") return "実行中";
  if (status === "error") return "エラー";
  if (status === "archived") return "アーカイブ済み";
  return "待機中";
}

export function BotCodeSessionPanel({ botId }: { botId: string }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState<string | null | undefined>();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [prompt, setPrompt] = useState("");
  const [followUps, setFollowUps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [session, projectResult] = await Promise.all([
        getJson<{ tasks?: TaskSummary[]; task?: TaskSummary | null }>(`/api/bots/${encodeURIComponent(botId)}/code-session`),
        getJson<{ projects: ProjectDto[] }>("/api/projects"),
      ]);
      setTasks(session.tasks ?? ((session as { task?: TaskSummary | null }).task ? [(session as { task: TaskSummary }).task] : []));
      const activeProjects = projectResult.projects.filter((project) => !project.archived);
      setProjects(activeProjects);
      setProjectId((current) => current === null ? null : current && activeProjects.some((p) => p.id === current) ? current : activeProjects[0]?.id ?? null);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Codeセッションを読み込めませんでした"); }
  }, [botId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!tasks.some((task) => task.status === "working")) return; const timer = window.setInterval(() => void load(), 2_000); return () => window.clearInterval(timer); }, [load, tasks]);

  const launch = async () => {
    if (projectId === undefined || !prompt.trim() || busy) return;
    setBusy(true); setError(null);
    try { const result = await sendJson<{ task: TaskSummary }>(`/api/bots/${encodeURIComponent(botId)}/code-session`, { projectId: projectId ?? null, prompt: prompt.trim() }, "POST"); setTasks((current) => [result.task, ...current]); setPrompt(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Codeセッションの起動に失敗しました"); }
    finally { setBusy(false); }
  };
  const control = async (task: TaskSummary, action: "abort" | "prompt") => {
    const value = followUps[task.id]; if (controlBusy || (action === "prompt" && !value?.trim())) return;
    setControlBusy(task.id); setError(null);
    try { const result = await sendJson<{ task: TaskSummary }>(`/api/bots/${encodeURIComponent(botId)}/code-session`, action === "prompt" ? { action, prompt: value.trim(), taskId: task.id } : { action, taskId: task.id }, "PATCH"); setTasks((current) => current.map((item) => item.id === task.id ? result.task : item)); if (action === "prompt") setFollowUps((current) => ({ ...current, [task.id]: "" })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Codeセッションの操作に失敗しました"); }
    finally { setControlBusy(null); }
  };

  return <section className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="Codeセッション">
    <div><h3 className="text-sm font-medium">Codeセッション</h3><p className="mt-1 text-xs text-muted">同じBotで複数のCodeセッションを並行して起動・監視できます。</p></div>
    {tasks.map((task) => <div key={task.id} className="rounded-xl border border-border bg-surface p-3 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-medium">{statusLabel(task.status)}</span><Link className="text-accent hover:underline" href={`/task/${encodeURIComponent(task.id)}`}>Codeを開く</Link></div><p className="mt-1 truncate text-muted" title={task.title}>{task.title}</p>{task.status !== "archived" && <div className="mt-3 space-y-2"><textarea value={followUps[task.id] ?? ""} onChange={(e) => setFollowUps((current) => ({ ...current, [task.id]: e.target.value }))} rows={2} placeholder="続きの指示（任意）" className="w-full resize-y rounded-lg border border-border bg-bg px-2 py-1.5 text-xs" /><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={controlBusy !== null || !followUps[task.id]?.trim()} onClick={() => void control(task, "prompt")}>指示を送る</Button><Button size="sm" variant="danger" disabled={controlBusy !== null || task.status !== "working"} onClick={() => void control(task, "abort")}>停止</Button></div></div>}</div>)}
    <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value || null)} className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm" aria-label="Codeプロジェクト"><option value="">{NO_PROJECT_NAME}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
    <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Codeに実行させる指示" className="w-full resize-y rounded-lg border border-border bg-surface px-2 py-1.5 text-xs" /><div className="flex justify-end"><Button size="sm" onClick={() => void launch()} busy={busy} disabled={projectId === undefined || !prompt.trim()}>Codeを起動</Button></div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
