"use client";

import { useMemo, useState } from "react";
import { sendJson } from "@/lib/client";
import { DEFAULT_ROUTINE_SCHEDULE, describeRoutineSchedule, nextRoutineRunAt } from "@/lib/routine-schedule";
import { RoutineSchedulePicker } from "./RoutineSchedulePicker";
import type { RoutineDto } from "@/lib/types";
import { Button } from "@/components/ui";

type RoutineDraft = { name: string; prompt: string; schedule: string };
const EMPTY_DRAFT: RoutineDraft = { name: "", prompt: "", schedule: DEFAULT_ROUTINE_SCHEDULE };

type BotRoutineSettingsProps = {
  botId: string;
  routines: RoutineDto[];
  onRefresh: () => Promise<void>;
  onError: (message: string | null) => void;
};

function formatDate(value: string | null): string {
  if (!value) return "未実行";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日時不明" : date.toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
}

export function BotRoutineSettings({ botId, routines, onRefresh, onError }: BotRoutineSettingsProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutineDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const nextRuns = useMemo(() => new Map(routines.map((routine) => [routine.id, routine.enabled ? nextRoutineRunAt(routine.schedule) : null])), [routines]);

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };
  const openCreate = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormOpen(true);
  };
  const openEdit = (routine: RoutineDto) => {
    setEditingId(routine.id);
    setDraft({ name: routine.name, prompt: routine.prompt, schedule: routine.schedule });
    setFormOpen(true);
  };
  const fail = (reason: unknown, fallback: string) => onError(reason instanceof Error ? reason.message : fallback);
  const save = async () => {
    if (!draft.name.trim() || !draft.prompt.trim() || !draft.schedule.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const path = `/api/bots/${encodeURIComponent(botId)}/routines${editingId ? `/${encodeURIComponent(editingId)}` : ""}`;
      await sendJson(path, { name: draft.name, prompt: draft.prompt, schedule: draft.schedule }, editingId ? "PATCH" : "POST");
      closeForm();
      await onRefresh();
    } catch (reason) {
      fail(reason, editingId ? "ルーティンの更新に失敗しました" : "ルーティンの作成に失敗しました");
    } finally {
      setSaving(false);
    }
  };
  const toggle = async (routine: RoutineDto) => {
    setBusyId(routine.id);
    onError(null);
    try {
      await sendJson(`/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routine.id)}`, { enabled: !routine.enabled }, "PATCH");
      await onRefresh();
    } catch (reason) {
      fail(reason, "ルーティンの更新に失敗しました");
    } finally {
      setBusyId(null);
    }
  };
  const testRun = async (routine: RoutineDto) => {
    setBusyId(routine.id);
    onError(null);
    try {
      await sendJson(`/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routine.id)}/run`, {}, "POST");
      await onRefresh();
    } catch (reason) {
      fail(reason, "ルーティンのテスト実行に失敗しました");
    } finally {
      setBusyId(null);
    }
  };
  const remove = async (routine: RoutineDto) => {
    if (!window.confirm(`「${routine.name}」を削除しますか？`)) return;
    setBusyId(routine.id);
    onError(null);
    try {
      await sendJson(`/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routine.id)}`, undefined, "DELETE");
      await onRefresh();
    } catch (reason) {
      fail(reason, "ルーティンの削除に失敗しました");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="ルーティン設定">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">ルーティン</h3>
          <p className="mt-1 text-xs text-muted">曜日や時刻を指定して、Botへの指示を自動実行します。</p>
        </div>
        <Button size="sm" disabled={saving} onClick={formOpen && !editingId ? closeForm : openCreate}>{formOpen && !editingId ? "閉じる" : "作成"}</Button>
      </div>
      {formOpen && (
        <div className="space-y-2 rounded-xl border border-accent/40 bg-surface p-3" role="dialog" aria-label={editingId ? "ルーティンを編集" : "ルーティンを作成"}>
          <p className="text-xs font-medium text-accent">{editingId ? "ルーティンを編集" : "ルーティンを作成"}</p>
          <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="名前（例: 朝の確認）" aria-label="ルーティン名" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
          <textarea value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder="Bot に実行させる指示" aria-label="ルーティンの指示" rows={3} className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
          <RoutineSchedulePicker key={editingId ?? "create"} initialSchedule={draft.schedule} onChange={(schedule) => setDraft((current) => ({ ...current, schedule }))} disabled={saving} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={saving} onClick={closeForm}>キャンセル</Button>
            <Button size="sm" onClick={() => void save()} busy={saving} disabled={!draft.name.trim() || !draft.prompt.trim() || !draft.schedule.trim()}>{editingId ? "変更を保存" : "作成"}</Button>
          </div>
        </div>
      )}
      {routines.length === 0 && <p className="text-xs text-muted">登録されたルーティンはありません。</p>}
      {routines.map((routine) => {
        const nextRun = nextRuns.get(routine.id);
        const busy = busyId === routine.id;
        return (
          <div key={routine.id} className="rounded-xl border border-border bg-surface p-3 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{routine.name} {routine.enabled ? <span className="text-success">有効</span> : <span className="text-muted">無効</span>}</p>
                <p className="mt-1 break-words text-muted">{describeRoutineSchedule(routine.schedule)}</p>
                <p className="mt-1 break-words text-muted">{routine.prompt}</p>
                <p className="mt-1 text-muted">最終実行: {formatDate(routine.lastRunAt)}</p>
                <p className="text-muted">{routine.enabled ? `次回実行: ${nextRun ? formatDate(nextRun.toISOString()) : "なし"}` : "次回実行: 一時停止中"}</p>
                {routine.failureCount > 0 && <p className="mt-1 text-danger"><span>連続失敗: {routine.failureCount}回</span>{!routine.enabled && <span>（自動停止の可能性があります）</span>}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-stretch gap-1">
                <Button size="sm" variant="ghost" disabled={busy} aria-label={routine.enabled ? "無効化" : "有効化"} onClick={() => void toggle(routine)}>{routine.enabled ? "一時停止" : "再開"}</Button>
                <Button size="sm" variant="ghost" disabled={busy || !routine.enabled} aria-label="今すぐ実行" onClick={() => void testRun(routine)}>テスト実行</Button>
                <Button size="sm" variant="ghost" disabled={busy || saving || editingId === routine.id} onClick={() => openEdit(routine)}>編集</Button>
                <button type="button" disabled={busy} onClick={() => void remove(routine)} className="px-2 py-1 text-danger hover:underline disabled:opacity-50">削除</button>
              </div>
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-muted">自動実行を止めるときは「一時停止」。保存後も「テスト実行」で安全に確認できます。</p>
    </section>
  );
}
