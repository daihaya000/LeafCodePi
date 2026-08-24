import { Badge } from "@/components/ui";
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

export function StatusBadge({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  return (
    <Badge tone={meta.tone} pulse={meta.pulse}>
      {meta.label}
    </Badge>
  );
}
