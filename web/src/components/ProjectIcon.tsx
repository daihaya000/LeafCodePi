import { memo, useState } from "react";
import { cx } from "@/components/ui";
import type { ProjectDto } from "@/lib/types";

const PROJECT_ICON_TONES = [
  "border-danger/30 bg-danger-bg text-danger",
  "border-success/30 bg-success-bg text-success",
  "border-warning/30 bg-warning-bg text-warning",
  "border-accent/30 bg-accent/10 text-accent",
] as const;

export const ProjectIcon = memo(function ProjectIcon({ project, className }: { project: Pick<ProjectDto, "id" | "name" | "icon">; className?: string }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  let hash = 0;
  for (const character of project.id) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  const showImage = Boolean(project.icon && project.icon !== failedIcon);
  return showImage ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={project.icon!} alt="" onError={() => setFailedIcon(project.icon!)} className={cx("rounded-md object-cover", className)} />
  ) : (
    <span className={cx(PROJECT_ICON_TONES[hash % PROJECT_ICON_TONES.length], className)}>{Array.from(project.name.trim().toUpperCase())[0] ?? "?"}</span>
  );
});
