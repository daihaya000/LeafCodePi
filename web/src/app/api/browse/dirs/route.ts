import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { browseAllowedRoots, isAllowedBrowsePath, oneDriveRoots } from "@/lib/browse-paths";
import { isAbsolutePath } from "@/lib/paths";
import { parseWindowsQuickAccess, type QuickAccessItem } from "@/lib/windows-quick-access";

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

function quickAccessKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function quickAccessEntries(windowsEntries: readonly QuickAccessItem[] = []): DirEntry[] {
  const home = homedir();
  const cloudRoot = oneDriveRoots()[0];
  const entries: DirEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string, path: string, kind?: EntryKind) => {
    const resolved = resolve(path);
    const key = quickAccessKey(resolved);
    if (seen.has(key) || !isDirectory(resolved)) return;
    seen.add(key);
    entries.push(kind ? { name, path: resolved, kind } : { name, path: resolved });
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

  for (const entry of windowsEntries) add(entry.name, entry.path);
  for (const root of browseAllowedRoots()) {
    const path = resolve(root);
    add(basename(path) || path, path, "project");
  }
  return entries;
}

const execFileAsync = promisify(execFile);
const QUICK_ACCESS_CACHE_MS = 10_000;
const WINDOWS_QUICK_ACCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}')
if ($null -eq $folder) { Write-Output '[]'; exit }
@($folder.Items() | Where-Object { $_.IsFolder } | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.Name; path = [string]$_.Path }
}) | ConvertTo-Json -Compress
`.trim();

let quickAccessCache: { expiresAt: number; entries: QuickAccessItem[] } | null = null;
let quickAccessLoad: Promise<QuickAccessItem[] | null> | null = null;

async function windowsQuickAccessEntries(): Promise<QuickAccessItem[]> {
  if (process.platform !== "win32") return [];
  const now = Date.now();
  if (quickAccessCache && quickAccessCache.expiresAt > now) return quickAccessCache.entries;

  const current = quickAccessLoad ?? (quickAccessLoad = (async () => {
    try {
      const encoded = Buffer.from(WINDOWS_QUICK_ACCESS_SCRIPT, "utf16le").toString("base64");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
        { timeout: 5_000, windowsHide: true, encoding: "utf8" },
      );
      return parseWindowsQuickAccess(String(stdout)).filter((entry) => isDirectory(entry.path));
    } catch {
      return null;
    }
  })());
  const entries = await current;
  if (quickAccessLoad === current) {
    quickAccessLoad = null;
    if (entries) quickAccessCache = { expiresAt: Date.now() + QUICK_ACCESS_CACHE_MS, entries };
  }
  return entries ?? quickAccessCache?.entries ?? [];
}

function allowedBrowseRoots(quickAccess: readonly DirEntry[]): string[] {
  return [...browseAllowedRoots(), ...quickAccess.map((entry) => entry.path)];
}

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("path");
  const requestedPath = requested?.trim() ?? "";
  if (requestedPath && !isAbsolutePath(requestedPath)) {
    return NextResponse.json({ error: "絶対パスを指定してください", path: null, entries: [] }, { status: 400 });
  }
  const target = requestedPath ? resolve(requestedPath) : homedir();
  const windowsEntries = await windowsQuickAccessEntries();
  const quickAccess = quickAccessEntries(windowsEntries);
  const roots = allowedBrowseRoots(quickAccess);
  if (!isAllowedBrowsePath(target, { roots })) {
    return NextResponse.json(
      { error: "このパスは参照できません", path: target, quickAccess, entries: [] },
      { status: 403 },
    );
  }
  const parentPath = dirname(target);
  const parent = parentPath !== target && isAllowedBrowsePath(parentPath, { roots }) ? parentPath : null;
  try {
    const entries = await readdir(target, { withFileTypes: true });
    const dirs: DirEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".git") continue;
      dirs.push({ name: entry.name, path: join(target, entry.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    return NextResponse.json({
      path: target,
      parent,
      quickAccess,
      entries: dirs,
    });
  } catch (error) {
    return NextResponse.json(
      {
        path: target,
        parent,
        quickAccess,
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
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'プロジェクトフォルダを選択'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
$d.Dispose()
`.trim();
  try {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-EncodedCommand", encoded],
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
