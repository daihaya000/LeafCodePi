import { resolve } from "node:path";
import type { QuickAccessItem } from "@/lib/windows-quick-access";
import type { XdgUserDirs } from "@/lib/xdg-user-dirs";

export type QuickAccessKind = "home" | "oneDrive" | "desktop" | "documents" | "downloads" | "pictures" | "project";
export type QuickAccessEntry = { name: string; path: string; kind?: QuickAccessKind };

export type UserFolderKind = Exclude<QuickAccessKind, "home" | "oneDrive" | "project">;

export type UserFolderCandidate = {
  name: string;
  kind: UserFolderKind;
  folders: string[];
};

function joinHome(home: string, ...parts: string[]): string {
  const separator = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  return [home.replace(/[\\/]+$/, ""), ...parts].join(separator);
}

/**
 * Candidate folders for the browse sidebar. Windows keeps the English + OneDrive
 * names; Linux/macOS also try XDG user-dirs and common localized names.
 */
export function userFolderCandidates(options: {
  home: string;
  cloudRoot?: string | null;
  xdg?: XdgUserDirs;
  platform?: string;
}): UserFolderCandidate[] {
  const home = options.home;
  const cloud = options.cloudRoot?.trim() || "";
  const xdg = options.xdg ?? {};
  const linuxLike = (options.platform ?? process.platform) !== "win32";

  const desktop = [
    ...(linuxLike && xdg.desktop ? [xdg.desktop] : []),
    joinHome(home, "Desktop"),
    ...(linuxLike ? [joinHome(home, "デスクトップ")] : []),
    ...(cloud ? [joinHome(cloud, "Desktop")] : []),
  ];
  const documents = [
    ...(linuxLike && xdg.documents ? [xdg.documents] : []),
    joinHome(home, "Documents"),
    ...(linuxLike ? [joinHome(home, "ドキュメント")] : []),
    ...(cloud ? [joinHome(cloud, "Documents")] : []),
  ];
  const downloads = [
    ...(linuxLike && xdg.downloads ? [xdg.downloads] : []),
    joinHome(home, "Downloads"),
    ...(linuxLike ? [joinHome(home, "ダウンロード")] : []),
  ];
  const pictures = [
    ...(linuxLike && xdg.pictures ? [xdg.pictures] : []),
    joinHome(home, "Pictures"),
    ...(linuxLike ? [joinHome(home, "ピクチャ"), joinHome(home, "ピクチャー")] : []),
  ];

  return [
    { name: "デスクトップ", kind: "desktop", folders: desktop },
    { name: "ドキュメント", kind: "documents", folders: documents },
    { name: "ダウンロード", kind: "downloads", folders: downloads },
    { name: "ピクチャ", kind: "pictures", folders: pictures },
  ];
}

export function buildQuickAccessEntries(options: {
  home: string;
  cloudRoot?: string | null;
  xdg?: XdgUserDirs;
  windowsEntries?: readonly QuickAccessItem[];
  projectRoots?: readonly string[];
  isDirectory: (path: string) => boolean;
  resolvePath?: (path: string) => string;
  platform?: string;
}): QuickAccessEntry[] {
  const platform = options.platform ?? process.platform;
  const resolvePath = options.resolvePath ?? ((path: string) => resolve(path));
  const entries: QuickAccessEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string, path: string, kind?: QuickAccessKind) => {
    const resolved = resolvePath(path);
    const key = platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key) || !options.isDirectory(resolved)) return;
    seen.add(key);
    entries.push(kind ? { name, path: resolved, kind } : { name, path: resolved });
  };

  add("ホーム", options.home, "home");
  for (const candidate of userFolderCandidates({
    home: options.home,
    cloudRoot: options.cloudRoot,
    xdg: options.xdg,
    platform,
  })) {
    const path = candidate.folders.find((folder) => options.isDirectory(resolvePath(folder)));
    if (path) add(candidate.name, path, candidate.kind);
  }
  if (options.cloudRoot) add("OneDrive", options.cloudRoot, "oneDrive");
  for (const entry of options.windowsEntries ?? []) add(entry.name, entry.path);
  for (const root of options.projectRoots ?? []) {
    const path = resolvePath(root);
    add(path.split(/[\\/]/).filter(Boolean).at(-1) || path, path, "project");
  }
  return entries;
}
