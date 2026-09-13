"use client";

import { useId, useState } from "react";
import {
  describeRoutineSchedule, routineScheduleCron, routineScheduleDraft,
  ROUTINE_INTERVALS, ROUTINE_WEEKDAYS, type RoutineScheduleDraft,
} from "@/lib/routine-schedule";

const controlClass = "min-h-11 w-full min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

// Remount when switching the routine being edited; incomplete fields stay local until valid.
export function RoutineSchedulePicker({ initialSchedule, onChange, disabled = false }: {
  initialSchedule: string;
  onChange: (schedule: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => routineScheduleDraft(initialSchedule));
  const id = useId();
  const schedule = routineScheduleCron(draft);
  const update = (patch: Partial<RoutineScheduleDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange(routineScheduleCron(next));
  };
  const timed = ["daily", "weekly", "monthly"].includes(draft.frequency);
  const error = !schedule.trim() ? (draft.frequency === "weekly" && !draft.weekdays.length ? "曜日を1つ以上選んでください。" : "実行日時を入力してください。") : null;

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 border-t border-border pt-3">
      <legend className="px-1 text-sm font-medium">実行日時</legend>
      <label className="block space-y-1 text-xs font-medium">
        <span>繰り返し</span>
        <select value={draft.frequency} onChange={(event) => {
          const frequency = event.target.value as RoutineScheduleDraft["frequency"];
          update({ frequency, ...(frequency === "custom" ? { cron: schedule || draft.cron } : {}) });
        }} className={controlClass}>
          <option value="daily">毎日</option>
          <option value="weekly">毎週・曜日指定</option>
          <option value="monthly">毎月</option>
          <option value="hourly">毎時</option>
          <option value="interval">分間隔</option>
          <option value="custom">カスタム（cron式）</option>
        </select>
      </label>
      {draft.frequency === "weekly" && (
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-xs font-medium">曜日（複数選択可）</legend>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <label key={day} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border bg-bg px-3 text-sm has-checked:border-accent has-checked:bg-accent/10">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={draft.weekdays.includes(day)} aria-label={`${ROUTINE_WEEKDAYS[day]}曜日`} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => update({ weekdays: (event.target.checked ? [...draft.weekdays, day] : draft.weekdays.filter((value) => value !== day)).sort((a, b) => a - b) })} />
                <span>{ROUTINE_WEEKDAYS[day]}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">平日は月〜金を選択（祝日も実行します）。</p>
        </fieldset>
      )}
      <div className="flex flex-wrap gap-3">
        {draft.frequency === "monthly" && (
          <label className="min-w-0 flex-1 basis-28 space-y-1 text-xs font-medium">
            <span>日付</span>
            <select value={draft.day} onChange={(event) => update({ day: event.target.value })} className={controlClass}>
              {Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}日</option>)}
            </select>
          </label>
        )}
        {timed && (
          <label className="min-w-0 flex-1 basis-36 space-y-1 text-xs font-medium">
            <span>実行時刻</span>
            <input type="time" step={60} required value={draft.time} aria-invalid={!draft.time || undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => update({ time: event.target.value })} className={controlClass} />
          </label>
        )}
        {draft.frequency === "hourly" && (
          <label className="w-full space-y-1 text-xs font-medium">
            <span>毎時の実行タイミング</span>
            <select value={draft.minute} onChange={(event) => update({ minute: event.target.value })} className={controlClass}>
              {Array.from({ length: 60 }, (_, minute) => <option key={minute} value={minute}>{minute}分</option>)}
            </select>
          </label>
        )}
        {draft.frequency === "interval" && (
          <label className="w-full space-y-1 text-xs font-medium">
            <span id={`${id}-interval-label`}>実行間隔</span>
            <select aria-labelledby={`${id}-interval-label`} aria-describedby={`${id}-interval-help`} value={draft.interval} onChange={(event) => update({ interval: event.target.value })} className={controlClass}>
              {ROUTINE_INTERVALS.map((minutes) => <option key={minutes} value={minutes}>{minutes}分ごと</option>)}
            </select>
            <span id={`${id}-interval-help`} className="block font-normal text-muted">毎時0分を基準に繰り返します。最短5分です。</span>
          </label>
        )}
      </div>
      {draft.frequency === "monthly" && Number(draft.day) > 28 && <p className="text-xs text-muted">{draft.day}日がない月は実行されません。</p>}
      {draft.frequency === "custom" && (
        <label className="block space-y-1 text-xs font-medium">
          <span id={`${id}-cron-label`}>cron スケジュール</span>
          <input aria-labelledby={`${id}-cron-label`} value={draft.cron} onChange={(event) => update({ cron: event.target.value })} spellCheck={false} autoCapitalize="off" aria-describedby={`${id}-cron-help`} className={`${controlClass} font-mono`} />
          <span id={`${id}-cron-help`} className="block font-normal text-muted">分 時 日 月 曜日（0=日曜）。例: 0 9 * * 1-5 → 平日9:00。最短5分、保存時に検証します。</span>
        </label>
      )}
      {error ? <p id={`${id}-error`} role="alert" className="text-xs text-danger">{error}</p> : (
        <p role="status" className="break-words rounded-lg bg-bg px-3 py-2 text-sm font-medium">{describeRoutineSchedule(schedule)} に実行</p>
      )}
      <p className="text-xs text-muted">時刻はBotを実行している環境のローカル時刻です。</p>
    </fieldset>
  );
}
