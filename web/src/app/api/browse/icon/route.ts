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
$d.Filter = 'Images (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.ico)|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.ico|All files (*.*)|*.*'
$initial = $env:LEAFCODE_PI_ICON_DIR
if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $d.InitialDirectory = $initial }
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
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
 * ホスト PC のネイティブダイアログでアイコン画像を選ぶ。
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
