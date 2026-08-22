import { NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { isAllowedBrowsePath, browseAllowedRoots } from "@/lib/browse-paths";
import { isAbsolutePath } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DirEntry = { name: string; path: string };

function windowsDrives(): DirEntry[] {
  if (process.platform !== "win32") return [];
  const drives: DirEntry[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const path = `${letter}:\\`;
    drives.push({ name: path, path });
  }
  return drives;
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
      quickAccess: [
        { name: "ホーム", path: homedir() },
        ...browseAllowedRoots()
          .filter((root) => root.toLowerCase() !== homedir().toLowerCase())
          .slice(0, 3)
          .map((root) => ({ name: root, path: root })),
        ...windowsDrives().slice(0, 2),
      ],
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
