import { NextRequest, NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { browseAllowedRoots, isAllowedBrowsePath, oneDriveRoots } from "@/lib/browse-paths";
import { isAbsolutePath } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EntryKind = "home" | "oneDrive" | "desktop" | "documents" | "downloads" | "pictures" | "project";
type DirEntry = { name: string; path: string; kind?: EntryKind };

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function quickAccessEntries(): DirEntry[] {
  const home = homedir();
  const cloudRoot = oneDriveRoots()[0];
  const entries: DirEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string, path: string, kind: EntryKind) => {
    const resolved = resolve(path);
    const key = resolved.toLowerCase();
    if (seen.has(key) || !isDirectory(resolved)) return;
    seen.add(key);
    entries.push({ name, path: resolved, kind });
  };

  add("ホーム", home, "home");
  for (const [name, folders, kind] of [
    ["デスクトップ", [join(home, "Desktop"), ...(cloudRoot ? [join(cloudRoot, "Desktop")] : [])], "desktop"],
    ["ドキュメント", [join(home, "Documents"), ...(cloudRoot ? [join(cloudRoot, "Documents")] : [])], "documents"],
    ["ダウンロード", [join(home, "Downloads")], "downloads"],
    ["ピクチャ", [join(home, "Pictures")], "pictures"],
  ] as const) {
    const path = folders.find(isDirectory);
    if (path) add(name, path, kind);
  }
  if (cloudRoot) add("OneDrive", cloudRoot, "oneDrive");

  for (const root of browseAllowedRoots()) {
    const path = resolve(root);
    if (seen.has(path.toLowerCase())) continue;
    add(basename(path) || path, path, "project");
  }
  return entries;
}

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("path");
  const target = requested && isAbsolutePath(requested) ? resolve(requested) : homedir();
  if (!isAllowedBrowsePath(target)) {
    return NextResponse.json(
      { error: "このパスは参照できません", path: target, entries: [] },
      { status: 403 },
    );
  }
  try {
    const entries = await readdir(target, { withFileTypes: true });
    const dirs: DirEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".git") continue;
      dirs.push({ name: entry.name, path: join(target, entry.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    const parent = dirname(target);
    return NextResponse.json({
      path: target,
      parent: parent !== target ? parent : null,
      quickAccess: quickAccessEntries(),
      entries: dirs,
    });
  } catch (error) {
    return NextResponse.json(
      {
        path: target,
        parent: parse(target).root !== target ? dirname(target) : null,
        entries: [],
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 200 },
    );
  }
}

export async function POST() {
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "ネイティブ選択は Windows のみです" }, { status: 400 });
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = 'プロジェクトフォルダを選択'",
    "$d.ShowNewFolderButton = $true",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      { timeout: 120_000, windowsHide: false, encoding: "utf8" },
    );
    const path = stdout.trim();
    if (!path) return NextResponse.json({ cancelled: true });
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) {
      return NextResponse.json({ error: "選択したパスはディレクトリではありません" }, { status: 400 });
    }
    return NextResponse.json({ path });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "フォルダ選択に失敗しました" },
      { status: 500 },
    );
  }
}
