import { memo, useState } from "react";
import { cx } from "@/components/ui";
import { PROJECT_ICON_COLORS, type ProjectDto, type ProjectIconColor } from "@/lib/types";

export const PROJECT_ICON_TONES = {
  red: "border-danger/30 bg-danger-bg text-danger",
  orange: "border-orange-500/30 bg-orange-50 text-orange-700 dark:border-orange-400/30 dark:bg-orange-950/50 dark:text-orange-300",
  yellow: "border-warning/30 bg-warning-bg text-warning",
  lime: "border-lime-500/30 bg-lime-50 text-lime-700 dark:border-lime-400/30 dark:bg-lime-950/50 dark:text-lime-300",
  green: "border-success/30 bg-success-bg text-success",
  emerald: "border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-950/50 dark:text-emerald-300",
  teal: "border-teal-500/30 bg-teal-50 text-teal-700 dark:border-teal-400/30 dark:bg-teal-950/50 dark:text-teal-300",
  cyan: "border-cyan-500/30 bg-cyan-50 text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-950/50 dark:text-cyan-300",
  blue: "border-accent/30 bg-accent/10 text-accent",
  indigo: "border-indigo-500/30 bg-indigo-50 text-indigo-700 dark:border-indigo-400/30 dark:bg-indigo-950/50 dark:text-indigo-300",
  purple: "border-purple-500/30 bg-purple-50 text-purple-700 dark:border-purple-400/30 dark:bg-purple-950/50 dark:text-purple-300",
  pink: "border-pink-500/30 bg-pink-50 text-pink-700 dark:border-pink-400/30 dark:bg-pink-950/50 dark:text-pink-300",
} satisfies Record<ProjectIconColor, string>;
const PROJECT_ICON_COLOR_KEYS = PROJECT_ICON_COLORS;

export const ProjectIcon = memo(function ProjectIcon({ project, className }: { project: Pick<ProjectDto, "id" | "name" | "icon" | "iconColor">; className?: string }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  let hash = 0;
  for (const character of project.id) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  const savedColor = PROJECT_ICON_COLOR_KEYS.find((color) => color === project.iconColor);
  const tone = PROJECT_ICON_TONES[savedColor ?? PROJECT_ICON_COLOR_KEYS[hash % PROJECT_ICON_COLOR_KEYS.length]!];
  const showImage = Boolean(project.icon && project.icon !== failedIcon);
  return showImage ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={project.icon!} alt="" onError={() => setFailedIcon(project.icon!)} className={cx("rounded-md object-cover", className)} />
  ) : (
    <span className={cx(tone, className)}>{Array.from(project.name.trim().toUpperCase())[0] ?? "?"}</span>
  );
});
