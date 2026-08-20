import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { isSafeLlamaPathValue } from "@/lib/llama-server-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function installationRoot(): string {
  // web/src/app/api/llama-server/models -> repo root
  return path.resolve(process.cwd(), process.cwd().endsWith(`${path.sep}web`) ? ".." : ".");
}

function batDefaultModel(): string | null {
  try {
    const bat = fs.readFileSync(
      path.join(installationRoot(), "scripts", "llama-server-load.bat"),
      "utf8",
    );
    const match = /if not defined MODEL_FILE set "MODEL_FILE=([^"\r\n]*)"/.exec(bat);
    return match?.[1] ? match[1] : null;
  } catch {
    return null;
  }
}

const MAX_DEPTH = 2;
const MAX_MODELS = 300;

function isNonFirstShard(name: string): boolean {
  const match = /-(\d{5})-of-\d{5}\.gguf$/i.exec(name);
  return match !== null && match[1] !== "00001";
}

function collect(root: string, rel: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_MODELS) return;
    const next = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) collect(root, next, depth + 1, out);
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".gguf") &&
      !isNonFirstShard(entry.name)
    ) {
      out.push(next);
    }
  }
}

export async function GET(req: NextRequest) {
  const defaultModel = batDefaultModel();
  const dir = (req.nextUrl.searchParams.get("dir") ?? "").trim();
  if (!dir) {
    return NextResponse.json({ dir: null, models: [], defaultModel });
  }
  if (!isSafeLlamaPathValue(dir)) {
    return NextResponse.json(
      { error: "モデル保存先に使用できない文字が含まれています" },
      { status: 400 },
    );
  }
  if (!path.isAbsolute(dir)) {
    return NextResponse.json(
      { error: "モデル保存先は絶対パスで指定してください" },
      { status: 400 },
    );
  }

  const resolved = path.resolve(dir);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    return NextResponse.json({ error: "モデル保存先が見つかりません" }, { status: 404 });
  }
  if (!stats.isDirectory()) {
    return NextResponse.json({ error: "モデル保存先がフォルダではありません" }, { status: 400 });
  }

  const models: string[] = [];
  collect(resolved, "", 0, models);
  models.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return NextResponse.json({ dir: resolved, models, defaultModel });
}
