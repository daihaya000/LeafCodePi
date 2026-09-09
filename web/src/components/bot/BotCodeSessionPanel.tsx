"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GoalLoopOptions, GoalLoopToggle } from "@/components/GoalLoopComposer";
import { GoalLoopPanel } from "@/components/GoalLoopPanel";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS, DEFAULT_GOAL_LOOP_MAX_TURNS } from "@/lib/goal-loop-settings";
import { NO_PROJECT_NAME, type GoalLoopDto, type ProjectDto, type TaskSummary } from "@/lib/types";

const LIVE_GOAL_LOOP_STATUSES = new Set<GoalLoopDto["status"]>(["queued", "running", "verifying_completed"]);

function statusLabel(status: TaskSummary["status"]): string {
  if (status === "working") return "実行中";
  if (status === "error") return "エラー";
  if (status === "archived") return "アーカイブ済み";
  return "待機中";
}
function goalLoopPayload(acceptance: string, maxTurns: number, cooldownSeconds: number, forceFullRun: boolean) {
  return { acceptance: acceptance.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), maxTurns, cooldownSeconds, forceFullRun };
}

export function BotCodeSessionPanel({ botId, onClose }: { botId: string; onClose?: () => void }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState<string | null | undefined>();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loops, setLoops] = useState<Record<string, GoalLoopDto | null>>({});
  const [prompt, setPrompt] = useState("");
  const [goalLoopEnabled, setGoalLoopEnabled] = useState(false);
  const [goalLoopAcceptance, setGoalLoopAcceptance] = useState("");
  const [goalLoopMaxTurns, setGoalLoopMaxTurns] = useState(DEFAULT_GOAL_LOOP_MAX_TURNS);
  const [goalLoopCooldownSeconds, setGoalLoopCooldownSeconds] = useState(DEFAULT_GOAL_LOOP_COOLDOWN_SECONDS);
  const [goalLoopForceFullRun, setGoalLoopForceFullRun] = useState(false);
  const [followUps, setFollowUps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);

  useEffect(() => () => { loadGenerationRef.current += 1; }, []);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    try {
      const [session, projectResult] = await Promise.all([
        getJson<{ tasks?: TaskSummary[]; task?: TaskSummary | null }>(`/api/bots/${encodeURIComponent(botId)}/code-session`),
        getJson<{ projects: ProjectDto[] }>("/api/projects"),
      ]);
      const nextTasks = session.tasks ?? ((session as { task?: TaskSummary | null }).task ? [(session as { task: TaskSummary }).task] : []);
      if (generation !== loadGenerationRef.current) return;
      setTasks(nextTasks);
      const activeProjects = projectResult.projects.filter((project) => !project.archived);
      setProjects(activeProjects);
      setProjectId((current) => current === null ? null : current && activeProjects.some((p) => p.id === current) ? current : activeProjects[0]?.id ?? null);
      const loopEntries = await Promise.all(nextTasks.filter((task) => task.goalLoopSummary).map(async (task) => {
        try { return [task.id, (await getJson<{ loop: GoalLoopDto | null }>(`/api/tasks/${encodeURIComponent(task.id)}/goal-loop`)).loop] as const; }
        catch { return [task.id, null] as const; }
      }));
      if (generation !== loadGenerationRef.current) return;
      setLoops(Object.fromEntries(loopEntries));
      setError(null);
    } catch (reason) {
      if (generation !== loadGenerationRef.current) return;
      setError(reason instanceof Error ? reason.message : "Codeセッションを読み込めませんでした");
    }
  }, [botId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!tasks.some((task) => task.status === "working" || (task.goalLoopSummary && LIVE_GOAL_LOOP_STATUSES.has(task.goalLoopSummary.status)))) return; const timer = window.setInterval(() => void load(), 2_000); return () => window.clearInterval(timer); }, [load, tasks]);

  const launch = async () => {
    if (projectId === undefined || !prompt.trim() || busy) return;
    setBusy(true); setError(null);
    try { const result = await sendJson<{ task: TaskSummary }>(`/api/bots/${encodeURIComponent(botId)}/code-session`, { projectId: projectId ?? null, prompt: prompt.trim(), ...(goalLoopEnabled ? { goalLoop: goalLoopPayload(goalLoopAcceptance, goalLoopMaxTurns, goalLoopCooldownSeconds, goalLoopForceFullRun) } : {}) }, "POST"); setTasks((current) => [result.task, ...current.filter((task) => task.id !== result.task.id)]); setPrompt(""); setGoalLoopEnabled(false); await load(); }
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
  const controlGoalLoop = async (taskId: string, action: "pause" | "resume" | "stop" | "complete", maxTurns?: number) => {
    if (controlBusy) return;
    setControlBusy(taskId); setError(null);
    try {
      const result = await sendJson<{ loop: GoalLoopDto | null }>(`/api/bots/${encodeURIComponent(botId)}/code-session`, { action: "goal-loop", goalLoopAction: action, taskId, ...(maxTurns === undefined ? {} : { maxTurns }) }, "PATCH");
      setLoops((current) => ({ ...current, [taskId]: result.loop }));
      setTasks((current) => current.map((task) => task.id === taskId ? { ...task, goalLoopSummary: result.loop ? { status: result.loop.status, maxTurns: result.loop.maxTurns, turnCount: result.loop.turnCount } : undefined } : task));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Goal Loopの操作に失敗しました"); }
    finally { setControlBusy(null); }
  };

  return <section id="bot-code-session-panel" className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="Codeセッション">
    <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-medium">Codeセッション</h3><p className="mt-1 text-xs text-muted">このBotが起動したCodeを開始・監視・操作できます。</p></div>{onClose && <Button size="sm" variant="ghost" onClick={onClose}>閉じる</Button>}</div>
    {tasks.length === 0 && <p className="text-xs text-muted">Codeセッションはまだありません。</p>}
    {tasks.map((task) => {
      const loop = loops[task.id]; const loopStatus = loop?.status ?? task.goalLoopSummary?.status;
      const showFollowUp = task.status !== "archived" && !(loopStatus && LIVE_GOAL_LOOP_STATUSES.has(loopStatus));
      return <div key={task.id} className="rounded-xl border border-border bg-surface p-3 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-medium">{statusLabel(task.status)}</span><Link className="text-accent hover:underline" href={`/task/${encodeURIComponent(task.id)}`}>Codeを開く</Link></div><p className="mt-1 truncate text-muted" title={task.title}>{task.title}</p>{loop && <GoalLoopPanel loop={loop} busy={controlBusy === task.id} onAction={(action) => void controlGoalLoop(task.id, action)} onResume={(maxTurns) => void controlGoalLoop(task.id, "resume", maxTurns)} />}{task.goalLoopSummary && !loop && <p className="mt-2 text-muted">Goal Loopの状態を読み込み中です…</p>}{showFollowUp && <div className="mt-3 space-y-2"><textarea value={followUps[task.id] ?? ""} onChange={(e) => setFollowUps((current) => ({ ...current, [task.id]: e.target.value }))} rows={2} aria-label={`${task.title}への続きの指示`} placeholder="続きの指示（任意）" className="w-full resize-y rounded-lg border border-border bg-bg px-2 py-1.5 text-xs" /><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={controlBusy !== null || !followUps[task.id]?.trim()} onClick={() => void control(task, "prompt")}>指示を送る</Button><Button size="sm" variant="danger" disabled={controlBusy !== null || task.status !== "working"} onClick={() => void control(task, "abort")}>停止</Button></div></div>}</div>;
    })}
    <div className="space-y-2 border-t border-border pt-3"><select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value || null)} className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm" aria-label="Codeプロジェクト"><option value="">{NO_PROJECT_NAME}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} aria-label="Codeへの指示" placeholder="Codeに実行させる指示" className="w-full resize-y rounded-lg border border-border bg-surface px-2 py-1.5 text-xs" /><GoalLoopToggle enabled={goalLoopEnabled} disabled={busy} onToggle={() => setGoalLoopEnabled((enabled) => !enabled)} />{goalLoopEnabled && <GoalLoopOptions acceptance={goalLoopAcceptance} maxTurns={goalLoopMaxTurns} cooldownSeconds={goalLoopCooldownSeconds} forceFullRun={goalLoopForceFullRun} disabled={busy} onAcceptanceChange={setGoalLoopAcceptance} onMaxTurnsChange={setGoalLoopMaxTurns} onCooldownSecondsChange={setGoalLoopCooldownSeconds} onForceFullRunChange={setGoalLoopForceFullRun} />}<div className="flex justify-end"><Button size="sm" onClick={() => void launch()} busy={busy} disabled={projectId === undefined || !prompt.trim()}>{goalLoopEnabled ? "ループを開始" : "Codeを起動"}</Button></div></div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
