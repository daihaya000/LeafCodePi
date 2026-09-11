import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { bundledExtensionsDir } from "@/lib/extensions";
import { readTtsConfig } from "@/lib/tts-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function serverDir(): string | null {
  const dir = bundledExtensionsDir();
  return dir ? join(dir, "leafcode-tts", "server") : null;
}

function healthUrl(): string | null {
  const { url } = readTtsConfig();
  if (!url) return null;
  try {
    return new URL("/v1/health", url).toString();
  } catch {
    return null;
  }
}

export async function GET() {
  const url = healthUrl();
  if (!url) return NextResponse.json({ running: false, error: "HTTP 合成 URL が未設定です" });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return NextResponse.json({ running: res.ok, url });
  } catch {
    return NextResponse.json({ running: false, url });
  }
}

export async function POST() {
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "起動スクリプトは Windows 専用です" }, { status: 400 });
  }
  const dir = serverDir();
  const script = dir ? join(dir, "start-rocm.ps1") : null;
  if (!script || !existsSync(script)) {
    return NextResponse.json({ error: "start-rocm.ps1 が見つかりません" }, { status: 404 });
  }
  if (!existsSync(join(dir!, "local.rocm.json"))) {
    return NextResponse.json(
      { error: "local.rocm.json がありません。local.rocm.example.json をコピーして設定してください" },
      { status: 400 },
    );
  }
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return NextResponse.json({ started: true, hint: "モデル読込に数分かかることがあります" });
}
