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
// Bound the synchronous walk (slow shares / huge trees must not stall the BFF worker).
const MAX_SCANNED_ENTRIES = 20_000;

function isNonFirstShard(name: string): boolean {
  const match = /-(\d{5})-of-\d{5}\.gguf$/i.exec(name);
  return match !== null && match[1] !== "00001";
}

/** Vision projectors are not launchable models; they are listed separately so
 *  the launch-model dropdown cannot resolve a family preset to e.g.
 *  "...GGUF\mmproj.gguf". */
export function isMmProj(name: string): boolean {
  return /mmproj/i.test(name);
}

export function isLora(name: string): boolean {
  return /lora/i.test(name);
}

function collect(
  root: string,
  rel: string,
  depth: number,
  models: string[],
  mmprojs: string[],
  loras: string[],
  budget: { remaining: number } = { remaining: MAX_SCANNED_ENTRIES },
): void {
  if (budget.remaining <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.remaining <= 0) return;
    budget.remaining -= 1;
    const next = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) collect(root, next, depth + 1, models, mmprojs, loras, budget);
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".gguf") &&
      !isNonFirstShard(entry.name)
    ) {
      if (isMmProj(entry.name)) {
        if (mmprojs.length < MAX_MODELS) mmprojs.push(next);
      } else if (isLora(entry.name)) {
        if (loras.length < MAX_MODELS) loras.push(next);
      } else if (models.length < MAX_MODELS) {
        models.push(next);
      }
    }
  }
}

/**
 * The scan is synchronous and walks up to MAX_SCANNED_ENTRIES per GET, so a UI that
 * polls while the user browses model files blocks the BFF each time. Results are
 * memoized per directory for a short TTL; a directory whose own mtime changed (a
 * file was added or removed) is rescanned immediately.
 */
type CollectedModels = { models: string[]; mmprojs: string[]; loras: string[] };

const SCAN_CACHE_TTL_MS = 5_000;
const SCAN_CACHE_LIMIT = 8;
type ScanCacheEntry = { scannedAt: number; dirMtimeMs: number; result: CollectedModels };
const scanCache = new Map<string, ScanCacheEntry>();

function scanModelsDirectory(resolved: string): CollectedModels {
  let dirMtimeMs = 0;
  try {
    dirMtimeMs = fs.statSync(/* turbopackIgnore: true */ resolved).mtimeMs;
  } catch {
    // An unreadable directory scans to empty; the caller already reported 404/400.
  }
  const cached = scanCache.get(resolved);
  const now = Date.now();
  if (cached && cached.dirMtimeMs === dirMtimeMs && now - cached.scannedAt < SCAN_CACHE_TTL_MS) {
    return cached.result;
  }
  const models: string[] = [];
  const mmprojs: string[] = [];
  const loras: string[] = [];
  collect(resolved, "", 0, models, mmprojs, loras);
  const byName = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: "base" });
  models.sort(byName);
  mmprojs.sort(byName);
  loras.sort(byName);
  const result = { models, mmprojs, loras };
  if (scanCache.size >= SCAN_CACHE_LIMIT) {
    const oldest = [...scanCache.entries()].sort((a, b) => a[1].scannedAt - b[1].scannedAt)[0];
    if (oldest) scanCache.delete(oldest[0]);
  }
  scanCache.set(resolved, { scannedAt: now, dirMtimeMs, result });
  return result;
}

/** Test-only: drop memoized directory scans. */
export function resetLlamaModelScanCacheForTests(): void {
  scanCache.clear();
}

export async function GET(req: NextRequest) {
  const defaultModel = batDefaultModel(process.platform);
  // An empty dir falls back to the platform's configured model directory:
  // presets must work before the user has saved a directory explicitly.
  const requested = (req.nextUrl.searchParams.get("dir") ?? "").trim();
  const dir = requested || defaultModelDir(process.platform, process.env) || "";
  if (!dir) {
    return NextResponse.json({ dir: null, models: [], mmprojs: [], loras: [], defaultModel });
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

  const { models, mmprojs, loras } = scanModelsDirectory(resolved);
  return NextResponse.json({ dir: resolved, models, mmprojs, loras, defaultModel });
}
