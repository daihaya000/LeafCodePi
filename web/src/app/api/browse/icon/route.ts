import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { readIconFileAsDataUrl } from "@/lib/icon-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

/** 起動フォルダーは環境変数で渡す（パスの quoting・文字化けを避ける）。 */
const ICON_DIALOG_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'プロジェクトアイコンを選択'
$d.Filter = 'Images and applications (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.ico;*.exe)|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.ico;*.exe|All files (*.*)|*.*'
$initial = $env:LEAFCODE_PI_ICON_DIR
if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $d.InitialDirectory = $initial }
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $selected = $d.FileName
  if ([System.IO.Path]::GetExtension($selected) -ieq '.exe') {
    try {
      Add-Type -AssemblyName System.Drawing
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($selected)
      if ($null -eq $icon) { throw 'icon unavailable' }
      $stream = New-Object System.IO.MemoryStream
      try {
        $icon.Save($stream)
        $payload = [ordered]@{
          kind = 'icon'
          name = [System.IO.Path]::GetFileName($selected)
          base64 = [Convert]::ToBase64String($stream.ToArray())
        } | ConvertTo-Json -Compress
        [Console]::Out.Write($payload)
      } finally {
        $stream.Dispose()
        $icon.Dispose()
      }
    } catch {
      [Console]::Out.Write('{"kind":"error"}')
    }
  } else {
    [Console]::Out.Write($selected)
  }
}
$d.Dispose()
`.trim();

function existingDirectory(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) return "";
  try {
    return statSync(path).isDirectory() ? path : "";
  } catch {
    return "";
  }
}

/**
 * ホスト PC のネイティブダイアログでアイコン画像または EXE を選ぶ。
 * 起動フォルダーは `path`（プロジェクトの rootPath）。呼び出しはホスト PC のブラウザに限る。
 */
export async function POST(req: NextRequest) {
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "ネイティブ選択は Windows のみです" }, { status: 501 });
  }
  const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
  const initialDir = existingDirectory(body?.path);
  try {
    const encoded = Buffer.from(ICON_DIALOG_SCRIPT, "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-EncodedCommand", encoded],
      {
        timeout: 120_000,
        windowsHide: false,
        encoding: "utf8",
        env: { ...process.env, LEAFCODE_PI_ICON_DIR: initialDir },
      },
    );
    const filePath = stdout.trim();
    if (!filePath) return NextResponse.json({ cancelled: true });
    if (filePath.startsWith("{")) {
      try {
        const payload = JSON.parse(filePath) as { kind?: unknown; name?: unknown; base64?: unknown };
        if (payload.kind === "error") {
          return NextResponse.json({ error: "EXEからアイコンを取得できませんでした。" }, { status: 400 });
        }
        if (payload.kind === "icon" && typeof payload.base64 === "string" && /^[A-Za-z0-9+/=]+$/.test(payload.base64) && payload.base64.length <= 3_000_000) {
          return NextResponse.json({
            icon: `data:image/x-icon;base64,${payload.base64}`,
            name: typeof payload.name === "string" && payload.name ? payload.name : "icon.exe",
          });
        }
      } catch {
        // Treat malformed output like an unsupported selection below.
      }
    }
    const result = readIconFileAsDataUrl(filePath);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ icon: result.icon, name: result.name });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "アイコン選択に失敗しました" },
      { status: 500 },
    );
  }
}
