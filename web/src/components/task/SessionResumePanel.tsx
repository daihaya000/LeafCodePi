"use client";

import { useEffect, useState } from "react";
import { AlarmClock } from "lucide-react";
import type { SessionResumeDto } from "@/lib/types";

export function formatSessionResumeRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  if (seconds === 0) return "再開待ち";
  if (seconds < 60) return `あと${seconds}秒`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `あと${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `あと${hours}時間${remainingMinutes}分` : `あと${hours}時間`;
}

function formatScheduledAt(due: Date, now: Date): string {
  const sameDay = due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() && due.getDate() === now.getDate();
  return sameDay
    ? due.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : due.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function SessionResumePanel({ reservation }: { reservation: SessionResumeDto | null | undefined }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const dueMs = reservation ? Date.parse(reservation.at) : NaN;

  useEffect(() => {
    if (!Number.isFinite(dueMs) || dueMs <= Date.now()) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= dueMs) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [dueMs]);

  if (!reservation || !Number.isFinite(dueMs)) return null;
  const overdue = dueMs <= nowMs;
  const due = new Date(dueMs);

  return (
    <section aria-label="セッション再開予約" className="w-full max-w-bubble rounded-card border border-border bg-surface-2 px-3 py-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <AlarmClock className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        <span className="shrink-0 font-medium text-text">再開予約</span>
        <time className="shrink-0 text-muted" dateTime={reservation.at}>
          {formatScheduledAt(due, new Date(nowMs))}
        </time>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted" title={overdue ? "セッションがアイドルになると再開する" : undefined}>
          {formatSessionResumeRemaining(dueMs - nowMs)}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted" title={reservation.message}>
        {reservation.message}
      </p>
      {overdue && <p className="mt-1 text-xs text-faint">セッションがアイドルになると再開します。</p>}
    </section>
  );
}
