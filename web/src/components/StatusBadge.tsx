"use client";

import { useEffect, useRef } from "react";
import { Badge, cx } from "@/components/ui";
import type { TaskStatus } from "@/lib/types";

const STATUS_META: Record<
  TaskStatus,
  { label: string; tone: "neutral" | "working" | "success" | "warning" | "danger"; pulse?: boolean }
> = {
  working: { label: "実行中", tone: "working", pulse: true },
  ready: { label: "変更あり", tone: "success" },
  idle: { label: "クリーン", tone: "neutral" },
  error: { label: "エラー", tone: "danger" },
  archived: { label: "アーカイブ済", tone: "neutral" },
  unknown: { label: "不明", tone: "neutral" },
};

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  const containerRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const badge = badgeRef.current;
    if (!container || !badge) return;

    const fitBadge = () => {
      // offsetWidth stays unscaled, so repeated resizes never compound the scale.
      const scale = badge.offsetWidth > 0
        ? Math.min(1, container.clientWidth / badge.offsetWidth)
        : 1;
      badge.style.transform = scale < 1 ? `scale(${scale})` : "";
    };
    fitBadge();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fitBadge);
    observer.observe(container);
    observer.observe(badge);
    return () => observer.disconnect();
  }, [meta.label]);

  return (
    <span ref={containerRef} className={cx("inline-flex min-w-0 max-w-full items-center", className)}>
      <span ref={badgeRef} className="inline-flex shrink-0 origin-left">
        <Badge tone={meta.tone} pulse={meta.pulse}>
          {meta.label}
        </Badge>
      </span>
    </span>
  );
}
