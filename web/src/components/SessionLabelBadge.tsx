"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui";
import { PROJECT_ICON_TONES } from "@/components/ProjectIcon";
import {
  findSessionLabel,
  hydrateSessionLabelsFromServer,
  readSessionLabels,
  subscribeSessionLabels,
  type SessionLabel,
} from "@/lib/session-label-settings";

/** Labels live in a browser-synced setting, so read them after hydration. */
function useSessionLabels(): SessionLabel[] {
  const [labels, setLabels] = useState<SessionLabel[]>([]);
  useEffect(() => {
    const update = () => setLabels(readSessionLabels());
    update();
    void hydrateSessionLabelsFromServer().then(update);
    return subscribeSessionLabels(update);
  }, []);
  return labels;
}

/** Unlabelled tasks show a gray "-" placeholder; nothing renders while labels are disabled. */
const BASE_FONT_SIZE = 9;

export function SessionLabelBadge({
  labelId,
  className,
}: {
  labelId?: string | null;
  className?: string;
}) {
  const labels = useSessionLabels();
  const label = findSessionLabel(labels, labelId);
  const labelName = label?.name;
  const badgeRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const badge = badgeRef.current;
    const text = textRef.current;
    if (!labelName || !badge || !text) return;

    const fitText = () => {
      const displayedWidth = text.getBoundingClientRect().width;
      const style = window.getComputedStyle(badge);
      const availableWidth = badge.clientWidth
        - (Number.parseFloat(style.paddingLeft) || 0)
        - (Number.parseFloat(style.paddingRight) || 0);
      if (displayedWidth <= 0 || availableWidth <= 0) return;

      const currentFontSize = Number.parseFloat(text.style.fontSize) || BASE_FONT_SIZE;
      const naturalWidth = displayedWidth * BASE_FONT_SIZE / currentFontSize;
      text.style.fontSize = `${Math.min(BASE_FONT_SIZE, BASE_FONT_SIZE * availableWidth / naturalWidth)}px`;
    };

    fitText();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fitText);
    observer.observe(badge);
    return () => observer.disconnect();
  }, [labelName]);

  if (!label) {
    if (labels.length === 0) return null;
    return (
      <span
        aria-hidden="true"
        data-placeholder="true"
        className={cx(
          "inline-block shrink-0 rounded border border-border bg-surface-2 px-[3px] text-[9px] leading-[14px] text-muted",
          className,
        )}
      >
        -
      </span>
    );
  }
  return (
    <span
      ref={badgeRef}
      className={cx(
        "inline-block shrink-0 rounded border px-[3px] text-[9px] leading-[14px]",
        PROJECT_ICON_TONES[label.color],
        className,
      )}
    >
      <span ref={textRef} className="inline-block whitespace-nowrap">{label.name}</span>
    </span>
  );
}
