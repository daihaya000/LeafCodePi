import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { bundledExtensionsDir } from "@/lib/extensions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PORT = 18080;

function serverDir(): string | null {
  const dir = bundledExtensionsDir();
  return dir ? join(dir, "leafcode-tts", "server") : null;
}

/** Qwen start/stop uses local.rocm.json — never the AivisSpeech/SAPI synthesis URL. */
export function readQwenPort(dir = serverDir()): number {
  const file = dir ? join(dir, "local.rocm.json") : null;
  if (!file || !existsSync(file)) return DEFAULT_PORT;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { port?: string | number };
    const port = Number(raw.port);
    return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1/health`;
}

export async function GET() {
  const port = readQwenPort();
  const url = healthUrl(port);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return NextResponse.json({ running: res.ok, url, port });
  } catch {
    return NextResponse.json({ running: false, url, port });
  }
}

export async function POST() {
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "起動スクリプトは Windows 専用です" }, { status: 400 });
  }
  const dir = serverDir();
  const script = dir ? join(dir, "start-rocm.ps1") : null;
  if (!dir || !script || !existsSync(script)) {
    return NextResponse.json({ error: "start-rocm.ps1 が見つかりません" }, { status: 404 });
  }
  if (!existsSync(join(dir, "local.rocm.json"))) {
    return NextResponse.json(
      { error: "local.rocm.json がありません。local.rocm.example.json をコピーして設定してください" },
      { status: 400 },
    );
  }
  // `cmd /c start` gives PowerShell its own console so it survives this request:
  // spawning it directly kills the tray when our console goes away, and Node's
  // detached flag leaves PowerShell with no console at all so it never starts.
  // The script hides that console itself once the tray icon is up.
  const child = spawn(
    "cmd.exe",
    ["/c", "start", "", "/min", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { stdio: "ignore", windowsHide: true, detached: true },
  );
  child.unref();
  return NextResponse.json({ started: true, port: readQwenPort(dir), hint: "モデル読込に数分かかることがあります" });
}

/** Kill the Qwen listener from local.rocm.json; tray watcher exits on its own. */
export async function DELETE() {
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "停止は Windows 専用です" }, { status: 400 });
  }
  const port = readQwenPort();

  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    "if (-not $c) { 'NOT_RUNNING'; exit 0 }",
    "$c.OwningProcess | Select-Object -Unique | ForEach-Object { & taskkill.exe /PID $_ /T /F | Out-Null }",
    "'STOPPED'",
  ].join("; ");

  const result = await new Promise<string>((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve("ERROR"));
    child.on("close", () => resolve(out.trim()));
  });

  if (result.includes("NOT_RUNNING")) {
    return NextResponse.json({ stopped: false, port, error: "起動していません" });
  }
  if (!result.includes("STOPPED")) {
    return NextResponse.json({ stopped: false, port, error: "停止に失敗しました" }, { status: 500 });
  }
  return NextResponse.json({ stopped: true, port });
}
