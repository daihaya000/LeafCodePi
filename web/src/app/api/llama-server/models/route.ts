import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isSafeLlamaPathValue } from "@/lib/llama-server-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function installationRoot(): string {
  // web/src/app/api/llama-server/models -> repo root (dev) or mirror root (prod)
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.cwd().endsWith(`${path.sep}web`) ? ".." : ".",
  );
}

function batDefaultModel(platform = process.platform): string | null {
  if (platform !== "win32") return null;
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

/** The bat's fallback MODEL_DIR, so an empty `dir` param still lists GGUFs. */
function batDefaultModelDir(platform = process.platform): string | null {
  if (platform !== "win32") return null;
  try {
    const bat = fs.readFileSync(
      path.join(installationRoot(), "scripts", "llama-server-load.bat"),
      "utf8",
    );
    const match = /if not defined MODEL_DIR set "MODEL_DIR=([^"\r\n]*)"/.exec(bat);
    return match?.[1] ? match[1] : null;
  } catch {
    return null;
  }
}

export function defaultModelDir(
  platform = process.platform,
  env = process.env,
): string | null {
  const configured = env.LEAFCODE_PI_LLAMA_MODEL_DIR?.trim();
  if (configured) return configured;
  if (platform !== "win32") return path.join(homedir(), "models", "llm");
  return batDefaultModelDir(platform);
}

const MAX_DEPTH = 2;
const MAX_MODELS = 300;

function isNonFirstShard(name: string): boolean {
  const match = /-(\d{5})-of-\d{5}\.gguf$/i.exec(name);
  return match !== null && match[1] !== "00001";
}

/** Vision projectors are not launchable models; they are listed separately so
 *  the launch-model dropdown cannot resolve a family preset to e.g.
 *  "...GGUF\mmproj.gguf". */
function isMmProj(name: string): boolean {
  return /^mmproj/i.test(name);
}

function collect(
  root: string,
  rel: string,
  depth: number,
  models: string[],
  mmprojs: string[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const next = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) collect(root, next, depth + 1, models, mmprojs);
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".gguf") &&
      !isNonFirstShard(entry.name)
    ) {
      if (isMmProj(entry.name)) {
        if (mmprojs.length < MAX_MODELS) mmprojs.push(next);
      } else if (models.length < MAX_MODELS) {
        models.push(next);
      }
    }
  }
}

export async function GET(req: NextRequest) {
  const defaultModel = batDefaultModel(process.platform);
  // An empty dir falls back to the platform's configured model directory:
  // presets must work before the user has saved a directory explicitly.
  const requested = (req.nextUrl.searchParams.get("dir") ?? "").trim();
  const dir = requested || defaultModelDir(process.platform, process.env) || "";
  if (!dir) {
    return NextResponse.json({ dir: null, models: [], mmprojs: [], defaultModel });
  }
  if (!isSafeLlamaPathValue(dir, process.platform)) {
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

  const resolved = path.resolve(/* turbopackIgnore: true */ dir);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(/* turbopackIgnore: true */ resolved);
  } catch {
    return NextResponse.json({ error: "モデル保存先が見つかりません" }, { status: 404 });
  }
  if (!stats.isDirectory()) {
    return NextResponse.json({ error: "モデル保存先がフォルダではありません" }, { status: 400 });
  }

  const models: string[] = [];
  const mmprojs: string[] = [];
  collect(resolved, "", 0, models, mmprojs);
  const byName = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: "base" });
  models.sort(byName);
  mmprojs.sort(byName);
  return NextResponse.json({ dir: resolved, models, mmprojs, defaultModel });
}
