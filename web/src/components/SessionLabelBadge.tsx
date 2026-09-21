"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { PROJECT_ICON_TONES } from "@/components/ProjectIcon";
import {
  findSessionLabel,
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
    return subscribeSessionLabels(update);
  }, []);
  return labels;
}

/** Renders nothing when the task has no label or its definition was deleted. */
export function SessionLabelBadge({
  labelId,
  className,
}: {
  labelId?: string | null;
  className?: string;
}) {
  const labels = useSessionLabels();
  const label = findSessionLabel(labels, labelId);
  if (!label) return null;
  return (
    <span
      className={cx(
        "shrink-0 rounded border px-1 text-[10px] leading-4",
        PROJECT_ICON_TONES[label.color],
        className,
      )}
    >
      {label.name}
    </span>
  );
}
