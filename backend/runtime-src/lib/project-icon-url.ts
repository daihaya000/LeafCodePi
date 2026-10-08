import { createHash } from "node:crypto";
import type { ProjectDto } from "@/lib/types";

/**
 * Project icons are stored as base64 data URLs (tens of KB each). Embedding them in every
 * `/api/projects` response made the list ~200KB, re-sent on each change and on every page load.
 * The list now carries a versioned URL instead; the image itself is served once and cached by the
 * browser until the icon changes (the version is a hash of the stored data URL).
 */
const DATA_URL_ICON = /^data:(image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/=]+)$/;

export function projectIconVersion(icon: string): string {
  return createHash("sha1").update(icon).digest("base64url").slice(0, 16);
}

export function projectIconUrl(projectId: string, icon: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/icon?v=${projectIconVersion(icon)}`;
}

/** Replace stored data-URL icons with their cacheable URL; other values pass through untouched. */
export function withProjectIconUrls<T extends Pick<ProjectDto, "id" | "icon">>(projects: readonly T[]): T[] {
  return projects.map((project) =>
    typeof project.icon === "string" && DATA_URL_ICON.test(project.icon)
      ? { ...project, icon: projectIconUrl(project.id, project.icon) }
      : project,
  );
}

export function decodeProjectIcon(icon: string | null | undefined): { mime: string; bytes: Buffer } | null {
  if (typeof icon !== "string") return null;
  const match = DATA_URL_ICON.exec(icon);
  if (!match) return null;
  return { mime: match[1]!, bytes: Buffer.from(match[2]!, "base64") };
}
