import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readSettingValue } from "@/lib/host-control";
import {
  isSafeLlamaPathValue,
  LLAMA_SERVER_SETTINGS_KEY,
  parseLlamaServerSettings,
} from "@/lib/llama-server-settings";

/**
 * Directories that can never hold a model directory: virtual filesystems and OS
 * system trees. Scanning them is both pointless and a way to enumerate the host,
 * and refusing them cannot break a user's external drive or model folder.
 */
const FORBIDDEN_MODEL_DIRS = new Set([
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/boot",
  "/etc",
  "/var/log",
  "/var/run",
]);

export function isForbiddenModelDirectory(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  // A POSIX-looking path is forbidden on every platform: /proc and friends have no
  // place in a model directory regardless of where the server runs.
  if (FORBIDDEN_MODEL_DIRS.has(path.posix.resolve(dir.replaceAll("\\", "/")))) return true;
  if (platform !== "win32") return false;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const normalized = path.win32.resolve(dir).toLowerCase();
  const roots = [systemRoot, path.win32.join(systemRoot, "System32"), process.env.ProgramData ?? "C:\\ProgramData"];
  return roots.some(
    (root) => normalized === root.toLowerCase() || normalized.startsWith(`${root.toLowerCase()}\\`),
  );
}

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

/**
 * Extra model roots the operator opted into. Semicolon-separated absolute paths
 * (`;` on every platform so Windows drive letters stay intact). Documented as
 * LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST.
 */
export function parseModelDirAllowlist(
  raw: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!raw?.trim()) return [];
  const resolvePath = platform === "win32" ? path.win32.resolve : path.posix.resolve;
  const out: string[] = [];
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!isSafeLlamaPathValue(trimmed, platform)) continue;
    if (!path.isAbsolute(trimmed) && !(platform === "win32" ? path.win32.isAbsolute(trimmed) : path.posix.isAbsolute(trimmed))) {
      continue;
    }
    out.push(resolvePath(trimmed));
  }
  return out;
}

/**
 * Directories the models listing may walk. Product rule (2026-10-05):
 * only known LeafCodePi / configured llama model roots + allowlist extras.
 * Arbitrary absolute paths outside these roots are refused.
 */
export function knownModelDirectoryRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  configuredModelDir?: string | null,
): string[] {
  const resolvePath = platform === "win32" ? path.win32.resolve : path.posix.resolve;
  const roots: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    if (!isSafeLlamaPathValue(trimmed, platform)) return;
    try {
      roots.push(resolvePath(trimmed));
    } catch {
      /* ignore unresolvable */
    }
  };
  push(defaultModelDir(platform, env));
  // POSIX home default is always a known LeafCodePi root, even when env overrides defaultModelDir.
  if (platform !== "win32") push(path.posix.join(homedir(), "models", "llm"));
  push(configuredModelDir);
  for (const extra of parseModelDirAllowlist(env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST, platform)) {
    push(extra);
  }
  // Dedupe case-insensitively on Windows.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    const key = platform === "win32" ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(root);
  }
  return unique;
}

export function isUnderAllowedModelRoot(
  dir: string,
  roots: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolvePath = platform === "win32" ? path.win32.resolve : path.posix.resolve;
  const sep = platform === "win32" ? path.win32.sep : path.posix.sep;
  let resolved: string;
  try {
    resolved = resolvePath(dir);
  } catch {
    return false;
  }
  const normalized = platform === "win32" ? resolved.toLowerCase() : resolved;
  return roots.some((root) => {
    const base = platform === "win32" ? root.toLowerCase() : root;
    return normalized === base || normalized.startsWith(`${base}${sep}`);
  });
}

function configuredSettingsModelDir(): string | null {
  try {
    const settings = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
    const dir = settings.modelDir?.trim();
    return dir || null;
  } catch {
    return null;
  }
}

const MAX_DEPTH = 2;
const MAX_MODELS = 300;
// Bound the walk (slow shares / huge trees must not stall the BFF worker).
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

async function collect(
  root: string,
  rel: string,
  depth: number,
  models: string[],
  mmprojs: string[],
  loras: string[],
  budget: { remaining: number } = { remaining: MAX_SCANNED_ENTRIES },
): Promise<void> {
  if (budget.remaining <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.remaining <= 0) return;
    budget.remaining -= 1;
    const next = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await collect(root, next, depth + 1, models, mmprojs, loras, budget);
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

const scansInFlight = new Map<string, Promise<CollectedModels>>();

/** Concurrent requests for one directory share a single walk. */
function scanModelsDirectory(resolved: string): Promise<CollectedModels> {
  const running = scansInFlight.get(resolved);
  if (running) return running;
  const scan = scanModelsDirectoryUncoalesced(resolved).finally(() => {
    if (scansInFlight.get(resolved) === scan) scansInFlight.delete(resolved);
  });
  scansInFlight.set(resolved, scan);
  return scan;
}

async function scanModelsDirectoryUncoalesced(resolved: string): Promise<CollectedModels> {
  let dirMtimeMs = 0;
  try {
    dirMtimeMs = (await fs.promises.stat(/* turbopackIgnore: true */ resolved)).mtimeMs;
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
  await collect(resolved, "", 0, models, mmprojs, loras);
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
  // A network location makes the server walk a remote share with local privileges.
  // Local drives and POSIX paths are untouched, so a model directory on an
  // external disk keeps working; only UNC / drive-relative targets are refused.
  // Checked before isAbsolute so Windows rejects them regardless of how the host
  // classifies the string.
  if (/^[\\/]{2}/.test(dir) || /^[A-Za-z]:[^\\/]/.test(dir)) {
    return NextResponse.json(
      { error: "ネットワーク・ドライブ相対パスはモデル保存先に指定できません" },
      { status: 400 },
    );
  }
  if (!path.isAbsolute(dir)) {
    return NextResponse.json(
      { error: "モデル保存先は絶対パスで指定してください" },
      { status: 400 },
    );
  }
  if (isForbiddenModelDirectory(dir, process.platform)) {
    return NextResponse.json(
      { error: "システムディレクトリはモデル保存先に指定できません" },
      { status: 400 },
    );
  }
  const allowedRoots = knownModelDirectoryRoots(
    process.platform,
    process.env,
    configuredSettingsModelDir(),
  );
  if (!isUnderAllowedModelRoot(dir, allowedRoots, process.platform)) {
    return NextResponse.json(
      {
        error:
          "許可されたモデル保存先の外です。LEAFCODE_PI_LLAMA_MODEL_DIR / 設定の modelDir / LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST 配下を指定してください",
      },
      { status: 403 },
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

  const { models, mmprojs, loras } = await scanModelsDirectory(resolved);
  return NextResponse.json({ dir: resolved, models, mmprojs, loras, defaultModel });
}
