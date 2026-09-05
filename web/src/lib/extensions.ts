/**
 * Global Pi extensions with ON/OFF via leafcode-pi state (not folder moves).
 * Disabled extensions are filtered out of AgentSession through
 * DefaultResourceLoader.extensionsOverride.
 *
 * Bundled LeafCode extensions are read directly from this repository's
 * extensions/ directory and win over same-name entries in ~/.pi.
 *
 * Discovery mirrors Pi's global extension roots:
 * - <repo>/extensions (bundled; resolved via LEAFCODE_PI_EXTENSIONS_DIR or cwd)
 * - ~/.pi/agent/extensions (direct *.ts/*.js files, subdirs with index.ts/index.js,
 *   and subdirs with a package.json "pi.extensions" manifest)
 * - ~/.pi/agent/git/<host>/<owner>/<repo> for entries declared by installed
 *   git packages (settings.json "packages"), such as ponytail.
 * - ~/.pi/agent/npm/node_modules/<name> for installed npm packages (e.g. leafcode-mcp-adapter).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolvePiAgentDir } from "@/lib/agents-md";
import { dataDir } from "@/lib/paths";

export type ExtensionDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  filePath: string;
  /** WebUI が機能依存している拡張は無効化できない。 */
  required: boolean;
};

export type ExtensionListResult = {
  extensions: ExtensionDto[];
  extensionsDir: string;
};

type ExtensionsState = {
  /** Extension names (basename of the entry) that must not load. */
  disabled: Record<string, true>;
};

export class ExtensionsError extends Error {
  constructor(
    readonly code: "invalid-name" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

export function extensionsErrorStatus(error: unknown): number {
  if (error instanceof ExtensionsError) {
    return error.code === "invalid-name" ? 400 : 404;
  }
  return 500;
}

export function extensionsStatePath(dir = dataDir()): string {
  return join(dir, "extensions-state.json");
}

export function extensionsDir(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "extensions");
}

/** Repository extensions/ dir shipped with LeafCodePi (bundled extensions). */
export function bundledExtensionsDir(): string | null {
  const override = process.env.LEAFCODE_PI_EXTENSIONS_DIR?.trim();
  const candidates = override ? [override] : [join(process.cwd(), "extensions"), join(process.cwd(), "..", "extensions")];
  for (const candidate of candidates) {
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

/** Bundled extension entries (<repo>/extensions/<name>/index.ts), repo path wins. */
export function bundledExtensionEntries(): DiscoveredEntry[] {
  const dir = bundledExtensionsDir();
  return dir ? discoverExtensionsInDir(dir) : [];
}

const emptyState = (): ExtensionsState => {
  return { disabled: {} };
};

// Prevent a removed bundled extension from being revived by a stale global copy.
const RETIRED_EXTENSION_NAMES = new Set(["leafcode-collaboration"]);
const BUNDLED_REPLACED_EXTENSION_NAMES = new Set(["pi-mcp-adapter"]);

/**
 * WebUI 本体が動かなくても切ってよい leafcode 拡張。
 * leafcode-* は原則 WebUI 依存（無効化禁止）。例外だけここに列挙する。
 */
const OPTIONAL_LEAFCODE_EXTENSIONS = new Set<string>([]);

/**
 * leafcode- 以外で WebUI が依存するエントリ。
 * settle-followup-claim は todowrite / commit-guard の settle 排他用共有モジュール。
 */
const WEBUI_REQUIRED_EXTENSION_NAMES = new Set(["settle-followup-claim"]);

/** LeafCodePi の WebUI が依存する拡張。無効化禁止。 */
export function isWebUiRequiredExtension(name: string): boolean {
  if (WEBUI_REQUIRED_EXTENSION_NAMES.has(name)) return true;
  return name.startsWith("leafcode-") && !OPTIONAL_LEAFCODE_EXTENSIONS.has(name);
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${Date.now()}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function readExtensionsState(path = extensionsStatePath()): ExtensionsState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExtensionsState>;
    const disabled: Record<string, true> = {};
    if (parsed.disabled && typeof parsed.disabled === "object" && !Array.isArray(parsed.disabled)) {
      for (const [key, value] of Object.entries(parsed.disabled)) {
        if (value === true && typeof key === "string" && key.trim()) disabled[key] = true;
      }
    }
    return { disabled };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[extensions] failed to read state", error);
    }
    return emptyState();
  }
}

export function writeExtensionsState(state: ExtensionsState, path = extensionsStatePath()): void {
  atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function isExtensionDisabled(name: string, state = readExtensionsState()): boolean {
  return state.disabled[name] === true;
}

/** Filter for DefaultResourceLoader.extensionsOverride. */
export function filterExtensionsByState<T extends { path: string }>(
  extensions: readonly T[],
  state = readExtensionsState(),
): T[] {
  return extensions.filter((extension) => {
    const name = basenameKey(extension.path);
    return !RETIRED_EXTENSION_NAMES.has(name) &&
      (isWebUiRequiredExtension(name) || state.disabled[name] !== true);
  });
}

/**
 * Stable per-extension key: the basename of the entry path. For an `index.*`
 * entry the directory name is used instead, so a subdirectory extension is
 * keyed by its folder (e.g. `ponytail/index.js` → `ponytail`).
 */
export function basenameKey(entryPath: string): string {
  const base = basename(entryPath);
  if (/^index\.(ts|js|mjs|cjs)$/i.test(base)) return basename(dirname(entryPath));
  return base.replace(/\.(ts|js|mjs|cjs)$/i, "");
}

type PiSettings = {
  packages?: string[];
};

export function readPiSettings(agentDir = resolvePiAgentDir()): PiSettings {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Partial<PiSettings>;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.packages)) {
      return { packages: parsed.packages.filter((value): value is string => typeof value === "string") };
    }
  } catch {
    /* ignore */
  }
  return { packages: [] };
}

/**
 * Resolve an installed package source to its clone/install directory.
 * - `git:github.com/owner/repo` / `https://github.com/owner/repo` → ~/.pi/agent/git/...
 * - `npm:<name>[@version]` → ~/.pi/agent/npm/node_modules/<name>
 */
export function resolvePackageDir(source: string, agentDir = resolvePiAgentDir()): string | null {
  const trimmed = source.trim();

  if (trimmed.startsWith("git:")) {
    const rest = trimmed.slice("git:".length);
    const withoutScheme = rest.replace(/^https?:\/\//, "");
    const normalized = withoutScheme.replace(/^git@github\.com:/, "github.com/");
    return join(agentDir, "git", normalized);
  }

  if (/^https?:\/\/github\.com\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const pathname = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
      return join(agentDir, "git", url.hostname, pathname);
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice("npm:".length);
    // Strip the version: "@scope/pkg@1.2" → "@scope/pkg", "pkg@1.2" → "pkg".
    const name = spec.startsWith("@")
      ? `@${spec.slice(1).split("@")[0]}`
      : spec.split("@")[0];
    if (!name) return null;
    return join(agentDir, "npm", "node_modules", name);
  }

  // `pi install ./path/to/package` keeps a local source in settings.json.
  // Resolve it from the Pi agent directory so the Extensions screen can list
  // the same package that Pi itself loads.
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
  if (/^(?:\.\.?)[\\/]/.test(trimmed)) return resolve(agentDir, trimmed);

  return null;
}

type DiscoveredEntry = { name: string; filePath: string; description?: string };

function discoverPackageExtensions(agentDir: string): DiscoveredEntry[] {
  const settings = readPiSettings(agentDir);
  const entries: DiscoveredEntry[] = [];
  for (const source of settings.packages ?? []) {
    const pkgDir = resolvePackageDir(source, agentDir);
    if (!pkgDir || !existsSync(/* turbopackIgnore: true */ pkgDir)) continue;
    const manifestExtensions = readPiManifestExtensions(pkgDir);
    if (manifestExtensions.length === 0) continue;
    const packageName = basename(pkgDir);
    for (const rel of manifestExtensions) {
      const resolved = join(/* turbopackIgnore: true */ pkgDir, rel);
      if (existsSync(/* turbopackIgnore: true */ resolved)) {
        entries.push({ name: packageName, filePath: resolved });
      }
    }
  }
  return entries;
}

function readPiManifestExtensions(dir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      pi?: { extensions?: unknown };
    };
    const declared = manifest.pi?.extensions;
    if (!Array.isArray(declared)) return [];
    return declared.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function discoverExtensionsInDir(dir: string): DiscoveredEntry[] {
  if (!existsSync(dir)) return [];
  const entries: DiscoveredEntry[] = [];
  let names: string[];
  try {
    names = readdirNames(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const entryPath = join(dir, name);
    // 1. Direct files: *.ts / *.js
    if (isFile(entryPath) && /\.(ts|js|mjs|cjs)$/i.test(name)) {
      entries.push({ name: basenameKey(entryPath), filePath: entryPath });
      continue;
    }
    // 2 & 3. Subdirectories with index or a pi.extensions manifest.
    if (isDirectory(entryPath)) {
      const index = ["index.ts", "index.js"].find((file) => existsSync(join(entryPath, file)));
      if (index) {
        entries.push({ name: basenameKey(entryPath), filePath: join(entryPath, index) });
        continue;
      }
      const declared = readPiManifestExtensions(entryPath);
      if (declared.length > 0) {
        for (const rel of declared) {
          const resolved = join(entryPath, rel);
          if (existsSync(resolved)) {
            entries.push({ name: basenameKey(entryPath), filePath: resolved });
          }
        }
      }
    }
  }
  return entries;
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export type ListExtensionsOptions = {
  /** Override the extensions dir (tests). */
  extensionsDir?: string;
  /** Override the bundled repo extensions dir; null disables bundled discovery. */
  bundledDir?: string | null;
};

/**
 * List globally discoverable extensions (~/.pi/agent/extensions).
 * Toggle keys by basename of the entry path.
 */
export function listExtensions(
  agentDir = resolvePiAgentDir(),
  options?: ListExtensionsOptions,
): ExtensionListResult {
  const dir = options?.extensionsDir ?? extensionsDir(agentDir);
  const state = readExtensionsState();
  const byName = new Map<string, DiscoveredEntry>();
  // Bundled repo extensions first: they own their names and must not be
  // shadowed by stale copies in ~/.pi or by settings.json packages.
  const bundled =
    options?.bundledDir === null ? [] : options?.bundledDir ? discoverExtensionsInDir(options.bundledDir) : bundledExtensionEntries();
  for (const entry of bundled) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  for (const entry of discoverExtensionsInDir(dir)) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  for (const entry of discoverPackageExtensions(agentDir)) {
    byName.set(entry.name, entry); // installed packages override local same-name entries
  }

  const extensions = [...byName.values()]
    .filter((entry) => !RETIRED_EXTENSION_NAMES.has(entry.name))
    .filter((entry) => !(BUNDLED_REPLACED_EXTENSION_NAMES.has(entry.name) && byName.has("leafcode-mcp-adapter")))
    .map(
      (entry): ExtensionDto => ({
        id: entry.name,
        name: entry.name,
        description: entry.description,
        enabled: isWebUiRequiredExtension(entry.name) || !isExtensionDisabled(entry.name, state),
        filePath: entry.filePath,
        required: isWebUiRequiredExtension(entry.name),
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { extensions, extensionsDir: dir };
}

export function setExtensionEnabled(
  name: string,
  enabled: boolean,
  agentDir = resolvePiAgentDir(),
  options?: ListExtensionsOptions,
): ExtensionListResult {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new ExtensionsError("invalid-name", "名前が不正です");
  }
  const listed = listExtensions(agentDir, options);
  if (!listed.extensions.some((extension) => extension.name === trimmed)) {
    throw new ExtensionsError("not-found", "拡張機能が見つかりません");
  }
  if (!enabled && isWebUiRequiredExtension(trimmed)) {
    throw new ExtensionsError("invalid-name", "WebUI が依存する拡張機能は無効化できません");
  }
  const state = readExtensionsState();
  if (enabled) delete state.disabled[trimmed];
  else state.disabled[trimmed] = true;
  writeExtensionsState(state);
  return listExtensions(agentDir, options);
}
