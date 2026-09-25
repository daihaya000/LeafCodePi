import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isAllowedBrowsePath } from "@/lib/browse-paths";
import { isIconCandidate, readIconFileAsDataUrl } from "@/lib/icon-file";
import { isAbsolutePath } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type IconEntry = { name: string; path: string; kind: "dir" | "file" };

/** 対象EXEは環境変数で渡す（パスの quoting・文字化けを避ける）。 */
const EXE_ICON_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$selected = $env:LEAFCODE_PI_ICON_FILE
try {
  Add-Type -AssemblyName System.Drawing
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($selected)
  if ($null -eq $icon) { throw 'icon unavailable' }
  $bitmap = $icon.ToBitmap()
  try {
    $stream = New-Object System.IO.MemoryStream
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
    } finally {
      $stream.Dispose()
    }
  } finally {
    $bitmap.Dispose()
    $icon.Dispose()
  }
} catch {
  [Console]::Out.Write('')
}
`.trim();

const EXE_ICON_ERROR = "EXEからアイコンを取得できませんでした。";

function resolveRequested(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || !isAbsolutePath(value.trim())) return null;
  return resolve(/*turbopackIgnore: true*/ value.trim());
}

/** アプリ内エクスプローラー用に、フォルダーとアイコン候補ファイルを列挙する。 */
export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("path");
  const target = requested?.trim() ? resolveRequested(requested) : homedir();
  if (!target) {
    return NextResponse.json({ error: "絶対パスを指定してください" }, { status: 400 });
  }
  if (!isAllowedBrowsePath(target)) {
    return NextResponse.json({ error: "このパスは参照できません" }, { status: 403 });
  }
  const parentPath = dirname(target);
  const parent = parentPath !== target && isAllowedBrowsePath(parentPath) ? parentPath : null;
  try {
    const dirs: IconEntry[] = [];
    const files: IconEntry[] = [];
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(target, entry.name);
      if (entry.isDirectory()) dirs.push({ name: entry.name, path, kind: "dir" });
      else if (entry.isFile() && isIconCandidate(entry.name)) files.push({ name: entry.name, path, kind: "file" });
    }
    const byName = (a: IconEntry, b: IconEntry) => a.name.localeCompare(b.name, "ja");
    return NextResponse.json({ path: target, parent, entries: [...dirs.sort(byName), ...files.sort(byName)] });
  } catch (error) {
    return NextResponse.json({
      path: target,
      parent,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** アプリ内エクスプローラーで選んだ画像またはEXEを data URL のアイコンへ変換する。 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
  const filePath = resolveRequested(body?.path);
  if (!filePath) return NextResponse.json({ error: "絶対パスを指定してください" }, { status: 400 });
  if (!isAllowedBrowsePath(filePath)) {
    return NextResponse.json({ error: "このパスは参照できません" }, { status: 403 });
  }
  if (extname(filePath).toLowerCase() !== ".exe") {
    const result = readIconFileAsDataUrl(filePath);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ icon: result.icon, name: result.name });
  }
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "EXEのアイコン取得は Windows のみです" }, { status: 400 });
  }
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return NextResponse.json({ error: "ファイルを選択してください。" }, { status: 400 });
  try {
    const encoded = Buffer.from(EXE_ICON_SCRIPT, "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        timeout: 15_000,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, LEAFCODE_PI_ICON_FILE: filePath },
      },
    );
    const base64 = String(stdout).trim();
    if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64) || base64.length > 3_000_000) {
      return NextResponse.json({ error: EXE_ICON_ERROR }, { status: 400 });
    }
    return NextResponse.json({ icon: `data:image/png;base64,${base64}`, name: basename(filePath) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : EXE_ICON_ERROR },
      { status: 500 },
    );
  }
}
