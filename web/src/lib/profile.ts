import { gzipSync, gunzipSync } from "node:zlib";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { resolvePiAgentDir } from "@/lib/agents-md";
import { dataDir } from "@/lib/paths";

const PROFILE_FORMAT = "leafcode-pi-profile";
const PROFILE_VERSION = 1;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_CONTENT_BYTES = 240 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 384 * 1024 * 1024;
// Installed npm/git extensions commonly contain tens of thousands of source and documentation files.
const MAX_PROFILE_FILES = 50_000;

const AGENT_FILES = [
  "AGENTS.md",
  "BOTS.md",
  "DESIGN.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
  "WORKFLOW.md",
  "auth.json",
  "leafcode-memory-config.json",
  "mcp.json",
  "models.json",
  "settings.json",
] as const;
const AGENT_DIRECTORIES = ["accounts", "agents", "extensions", "git", "intercom", "npm", "skills"] as const;
const DATA_FILES = [
  "accounts.json",
  "browser-config.json",
  "extensions-state.json",
  "permission-gate.json",
  "provider-endpoints.json",
  "provider-model-state.json",
  "provider-routing.json",
  "skills-state.json",
  "tts.json",
  "web-settings.json",
  "webui-auth.json",
] as const;
const DATA_DIRECTORIES = ["settings"] as const;

type ProfileArchive = {
  format: typeof PROFILE_FORMAT;
  version: typeof PROFILE_VERSION;
  createdAt: string;
  files: Record<string, string>;
  /** POSIX executable bits for imported package scripts; absent in v1 profiles. */
  modes?: Record<string, number>;
};

export type ProfileSummary = {
  fileCount: number;
  bytes: number;
};

export type ResetProfileSummary = ProfileSummary & {
  backupPath: string;
};

type ProfileRoots = {
  agentDir?: string;
  leafcodeDir?: string;
};

function roots(options: ProfileRoots = {}) {
  return {
    agentDir: resolve(options.agentDir ?? resolvePiAgentDir()),
    leafcodeDir: resolve(options.leafcodeDir ?? dataDir()),
  };
}

function profilePath(root: "agent" | "data", path: string): string {
  return `${root}/${path.replaceAll("\\", "/")}`;
}

function isSafeRelativePath(path: string): boolean {
  return !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isAllowedProfilePath(path: string): boolean {
  const [root, ...parts] = path.split("/");
  if ((root !== "agent" && root !== "data") || parts.length === 0 || !isSafeRelativePath(parts.join("/"))) {
    return false;
  }
  const [entry] = parts;
  if (root === "agent") {
    return (parts.length === 1 && AGENT_FILES.includes(entry as never)) || (parts.length > 1 && AGENT_DIRECTORIES.includes(entry as never));
  }
  return (parts.length === 1 && DATA_FILES.includes(entry as never)) || (parts.length > 1 && DATA_DIRECTORIES.includes(entry as never));
}

type ProfileTotal = { bytes: number; fileCount: number; agentDir: string; leafcodeDir: string };

function addFile(files: Record<string, string>, modes: Record<string, number>, key: string, path: string, total: ProfileTotal) {
  const stat = lstatSync(path);
  if (!stat.isFile()) return;
  total.bytes += stat.size;
  if (total.bytes > MAX_CONTENT_BYTES) {
    throw new Error(`プロファイルが${MAX_CONTENT_BYTES / 1024 / 1024}MBを超えています`);
  }
  if (total.fileCount >= MAX_PROFILE_FILES) {
    throw new Error(`プロファイルのファイル数が${MAX_PROFILE_FILES}件を超えています`);
  }
  files[key] = readFileSync(path).toString("base64");
  modes[key] = stat.mode & 0o777;
  total.fileCount += 1;
}

function addDirectory(files: Record<string, string>, modes: Record<string, number>, root: "agent" | "data", directory: string, total: ProfileTotal) {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      addDirectory(files, modes, root, path, total);
      continue;
    }
    if (entry.isFile()) {
      const key = profilePath(root, relative(root === "agent" ? total.agentDir : total.leafcodeDir, path));
      addFile(files, modes, key, path, total);
    }
  }
}

/** Export only portable settings, credentials, and user-installed agent resources. */
export function exportProfile(options: ProfileRoots = {}): { archive: Buffer; summary: ProfileSummary } {
  const { agentDir, leafcodeDir } = roots(options);
  const files: Record<string, string> = {};
  const modes: Record<string, number> = {};
  const total: ProfileTotal = { bytes: 0, fileCount: 0, agentDir, leafcodeDir };

  for (const name of AGENT_FILES) {
    const path = join(agentDir, name);
    if (existsSync(path)) addFile(files, modes, profilePath("agent", name), path, total);
  }
  for (const name of AGENT_DIRECTORIES) addDirectory(files, modes, "agent", join(agentDir, name), total);
  for (const name of DATA_FILES) {
    const path = join(leafcodeDir, name);
    if (existsSync(path)) addFile(files, modes, profilePath("data", name), path, total);
  }
  for (const name of DATA_DIRECTORIES) addDirectory(files, modes, "data", join(leafcodeDir, name), total);

  const archive: ProfileArchive = {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    createdAt: new Date().toISOString(),
    files,
    modes,
  };
  return {
    archive: gzipSync(Buffer.from(JSON.stringify(archive), "utf8")),
    summary: { fileCount: total.fileCount, bytes: total.bytes },
  };
}

function parseProfile(archive: Buffer): ProfileArchive {
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("プロファイルファイルが大きすぎます");
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES }).toString("utf8"));
  } catch {
    throw new Error("有効なLeafCodePiプロファイルではありません");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("プロファイル形式が不正です");
  const profile = parsed as Partial<ProfileArchive>;
  if (profile.format !== PROFILE_FORMAT || profile.version !== PROFILE_VERSION || !profile.files || typeof profile.files !== "object" || Array.isArray(profile.files)) {
    throw new Error("対応していないプロファイル形式です");
  }
  const files = Object.entries(profile.files);
  if (files.length > MAX_PROFILE_FILES) throw new Error("プロファイルのファイル数が多すぎます");
  if (profile.modes !== undefined && (typeof profile.modes !== "object" || profile.modes === null || Array.isArray(profile.modes))) {
    throw new Error("プロファイルの権限情報が不正です");
  }
  const modes = profile.modes ?? {};
  if (Object.keys(modes).length > files.length) throw new Error("プロファイルの権限情報が不正です");
  for (const [path, mode] of Object.entries(modes)) {
    if (!Object.hasOwn(profile.files, path) || !isAllowedProfilePath(path) || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error("プロファイルの権限情報が不正です");
    }
  }
  let bytes = 0;
  for (const [path, content] of files) {
    if (!isAllowedProfilePath(path) || typeof content !== "string") throw new Error("プロファイルに許可されないパスがあります");
    const decoded = Buffer.from(content, "base64");
    if (decoded.toString("base64") !== content) throw new Error("プロファイルの内容が壊れています");
    bytes += decoded.length;
    if (bytes > MAX_CONTENT_BYTES) throw new Error("プロファイルの展開サイズが大きすぎます");
  }
  return profile as ProfileArchive;
}

function removeConfiguredPaths(agentDir: string, leafcodeDir: string): void {
  for (const name of AGENT_FILES) rmSync(join(agentDir, name), { force: true });
  for (const name of AGENT_DIRECTORIES) rmSync(join(agentDir, name), { recursive: true, force: true });
  for (const name of DATA_FILES) rmSync(join(leafcodeDir, name), { force: true });
  for (const name of DATA_DIRECTORIES) rmSync(join(leafcodeDir, name), { recursive: true, force: true });
}

function writeProfileBackup(archive: Buffer, leafcodeDir: string): string {
  const directory = join(leafcodeDir, "profile-backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const base = `leafcode-pi-profile-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`;
  for (let index = 0; ; index += 1) {
    const path = join(directory, `${base}${index ? `-${index}` : ""}.bak.lcp.gz`);
    try {
      writeFileSync(path, archive, { mode: 0o600, flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function destination(path: string, agentDir: string, leafcodeDir: string): string {
  const [root, ...parts] = path.split("/");
  const base = root === "agent" ? agentDir : leafcodeDir;
  const result = resolve(base, ...parts);
  if (result !== base && !result.startsWith(`${base}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("プロファイルの出力先が不正です");
  }
  return result;
}

function importedFileMode(mode: number | undefined): number {
  // Profiles contain credentials; preserve only the owner-executable bit needed by package scripts.
  return 0o600 | ((mode ?? 0) & 0o100);
}

function applyProfile(profile: ProfileArchive, agentDir: string, leafcodeDir: string): ProfileSummary {
  const files = Object.entries(profile.files).map(([profilePath, content]) => ({
    path: destination(profilePath, agentDir, leafcodeDir),
    content: Buffer.from(content, "base64"),
    mode: importedFileMode(profile.modes?.[profilePath]),
  }));
  removeConfiguredPaths(agentDir, leafcodeDir);
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
    writeFileSync(file.path, file.content, { mode: file.mode });
  }
  return { fileCount: files.length, bytes: files.reduce((total, file) => total + file.content.length, 0) };
}

/** Back up all profile-managed settings, then remove them for a clean start. */
export function resetProfile(options: ProfileRoots = {}): ResetProfileSummary {
  const { agentDir, leafcodeDir } = roots(options);
  const { archive, summary } = exportProfile({ agentDir, leafcodeDir });
  const backupPath = writeProfileBackup(archive, leafcodeDir);
  try {
    removeConfiguredPaths(agentDir, leafcodeDir);
    return { ...summary, backupPath };
  } catch (error) {
    try {
      applyProfile(parseProfile(archive), agentDir, leafcodeDir);
    } catch {
      // The original failure is more actionable; the backup remains available for manual recovery.
    }
    throw error;
  }
}

/** Replace all profile-managed settings after validating the entire archive. */
export function importProfile(archive: Buffer, options: ProfileRoots = {}): ProfileSummary {
  const profile = parseProfile(archive);
  const { agentDir, leafcodeDir } = roots(options);
  // Keep a validated in-memory rollback point so a full disk or permission failure cannot leave a half-imported profile.
  const previous = exportProfile({ agentDir, leafcodeDir }).archive;
  try {
    return applyProfile(profile, agentDir, leafcodeDir);
  } catch (error) {
    try {
      applyProfile(parseProfile(previous), agentDir, leafcodeDir);
    } catch {
      // The original failure is more actionable; a failed rollback is reported by the caller's recovery instructions.
    }
    throw error;
  }
}
