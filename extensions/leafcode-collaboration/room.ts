import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  COLLABORATION_CHECK_IDS,
  collaborationDataDir,
  readCollaborationConfig,
  type CollaborationCheck,
  type CollaborationCheckId,
  type CollaborationConfig,
} from "./config.ts";

const SNAPSHOT_SCHEMA = 1;
const MAX_RPC_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 5_000;
const MAX_SELECTOR_COUNT = 64;
const MAX_PATH_LENGTH = 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_INBOX_MESSAGES = 100;
const MAX_INBOX_RESPONSE_BYTES = 1_500_000;
const MESSAGE_RATE_WINDOW_MS = 60_000;
const MAX_MESSAGES_PER_WINDOW = 30;
const CHECK_TIMEOUT_MS = 120_000;
const OFFLINE_GIT_CHANGE_REASON = "HEAD or refs changed while the coordinator was offline.";

export type PresenceState = "active" | "idle" | "away" | "stuck" | "offline";
export type LeaseState = "active" | "dirty" | "invalid" | "orphaned" | "released";
export type PresenceUpdate = {
  state?: Exclude<PresenceState, "offline">;
  currentTool?: string | null;
  currentPaths?: string[];
  progress?: boolean;
};

export type FileIdentity = {
  realpath: string;
  dev: number;
  ino: number;
  nlink: number;
};

export type ActivityEntry = {
  seq: number;
  kind: "join" | "leave" | "heartbeat" | "claim" | "reserve" | "release" | "write" | "edit" | "check" | "commit" | "send" | "ask" | "reply" | "lease-invalid" | "compromised";
  sessionId: string;
  paths: string[];
  at: string;
};

export type RoomMessage = {
  id: string;
  kind: "send" | "ask" | "reply";
  fromSessionId: string;
  toSessionId: string;
  requestId?: string;
  message: string;
  at: string;
};

export type AskResult = {
  requestId: string;
  expiresAt: string;
};

export type PendingAsk = {
  requestId: string;
  fromSessionId: string;
  toSessionId: string;
  expiresAt: string;
};

export type SessionPresence = {
  sessionId: string;
  connectionId: string;
  displayName: string;
  pid: number;
  state: PresenceState;
  taskId?: string;
  goal?: string;
  currentTool?: string;
  currentPaths: string[];
  joinedAt: string;
  lastHeartbeatAt: string;
  lastProgressAt: string;
};

export type TaskClaim = {
  id: string;
  ownerSessionId: string;
  title: string;
  goal?: string;
  leaseIds: string[];
  status: "active" | "blocked" | "done";
  updatedAt: string;
};

export type FileLease = {
  id: string;
  ownerSessionId: string;
  selectors: string[];
  epoch: number;
  fencingToken: number;
  state: LeaseState;
  acquiredHeadOid?: string;
  baseline: Record<string, string | null>;
  observed: Record<string, string | null>;
  identities: Record<string, FileIdentity>;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
};

export type RoomSnapshot = {
  schema: 1;
  projectKey: string;
  epoch: number;
  seq: number;
  head: { branch?: string; oid?: string };
  sessions: Record<string, SessionPresence>;
  tasks: Record<string, TaskClaim>;
  leases: Record<string, FileLease>;
  pendingAsks: PendingAsk[];
  activity: ActivityEntry[];
  updatedAt: string;
  refFingerprint?: string;
  compromised?: { reason: string; at: string };
};

export type CheckResult = {
  checkId: string;
  code: number;
  stdout: string;
  stderr: string;
};

export type CommitResult = {
  oid: string;
  paths: string[];
  epoch: number;
};

export type ProjectIdentity = {
  root: string;
  projectKey: string;
  roomDir: string;
  lockPath: string;
  snapshotPath: string;
  socketPath: string;
};

export type RoomSessionInfo = {
  sessionId: string;
  displayName?: string;
  pid?: number;
};

type LockRecord = {
  schema: 1;
  pid: number;
  connectionId: string;
  epoch: number;
  heartbeatAt: string;
};

type RpcRequest = {
  id: string;
  method: string;
  payload?: unknown;
  epoch: number;
  sessionId: string;
  connectionId: string;
};

type RpcResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

type CommandResult = { code: number; stdout: string; stderr: string };

export class RoomError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class LockHeldError extends RoomError {
  constructor() {
    super("lock_held", "Another LeafCode coordinator owns this room.");
  }
}

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function dominantEol(text: string): "\r\n" | "\n" {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? "\r\n" : "\n";
}

export function applyUniqueTextEdit(currentText: string, oldText: string, newText: string): string {
  const currentNorm = normalizeNewlines(currentText);
  const oldNorm = normalizeNewlines(oldText);
  const first = currentNorm.indexOf(oldNorm);
  if (first < 0 || currentNorm.indexOf(oldNorm, first + oldNorm.length) >= 0) {
    throw new RoomError("edit_mismatch", "oldText must match exactly once.");
  }
  const replaced = `${currentNorm.slice(0, first)}${normalizeNewlines(newText)}${currentNorm.slice(first + oldNorm.length)}`;
  return dominantEol(currentText) === "\r\n" ? replaced.replaceAll("\n", "\r\n") : replaced;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function relativeKey(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isUnder(root: string, candidate: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeName(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, " ").trim();
  return normalized.slice(0, 120) || fallback;
}

function runProgram(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError: RoomError | undefined;
    let timer: NodeJS.Timeout;
    const terminate = (error: RoomError): void => {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(timer);
      try {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    timer = setTimeout(() => terminate(new RoomError("command_timeout", `${file} timed out: ${args.join(" ")}`)), timeoutMs);
    const append = (kind: "stdout" | "stderr", chunk: unknown) => {
      if (terminationError) return;
      const text = String(chunk);
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") + Buffer.byteLength(text, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
        terminate(new RoomError("output_too_large", `${file} produced too much output.`));
        return;
      }
      if (kind === "stdout") stdout += text;
      else stderr += text;
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(terminationError ?? error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationError) {
        reject(terminationError);
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function command(cwd: string, args: string[], timeoutMs = 8_000, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const commandEnv: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
  const temporaryIndex = env?.GIT_INDEX_FILE;
  delete commandEnv.GIT_DIR;
  delete commandEnv.GIT_WORK_TREE;
  delete commandEnv.GIT_COMMON_DIR;
  delete commandEnv.GIT_INDEX_FILE;
  delete commandEnv.GIT_OBJECT_DIRECTORY;
  delete commandEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  if (temporaryIndex) commandEnv.GIT_INDEX_FILE = temporaryIndex;
  return runProgram(
    "git",
    ["-c", "core.quotepath=false", ...args],
    cwd,
    timeoutMs,
    { ...commandEnv, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  );
}

export async function resolveProjectIdentity(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectIdentity> {
  const result = await command(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) throw new RoomError("not_git_repository", result.stderr.trim() || "cwd is not a Git repository.");
  const root = fs.realpathSync.native(result.stdout.trim());
  const projectKey = createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex");
  const roomDir = path.join(collaborationDataDir(env), "rooms", projectKey);
  return {
    root,
    projectKey,
    roomDir,
    lockPath: path.join(roomDir, "coordinator.lock"),
    snapshotPath: path.join(roomDir, "snapshot.json"),
    socketPath: process.platform === "win32" ? `\\\\.\\pipe\\leafcode-pi-${projectKey}` : path.join(roomDir, "room.sock"),
  };
}

export function normalizeSelector(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH || value.includes("\0")) {
    throw new RoomError("invalid_path", "Path selector is invalid.");
  }
  const raw = value.replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.startsWith("//") || raw.startsWith("\\\\")) {
    throw new RoomError("invalid_path", "Absolute paths are not allowed.");
  }
  const prefix = raw.endsWith("/**");
  const body = prefix ? raw.slice(0, -3) : raw;
  if (!body || body.includes("*") || body.includes("?") || body.split("/").some((part) => part === "..")) {
    throw new RoomError("invalid_path", "Only exact paths and a trailing /** selector are allowed.");
  }
  const parts = body.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) throw new RoomError("invalid_path", "Path traversal is not allowed.");
  if (parts.includes(".git") || parts.includes(".env") || parts.includes(".ssh") || parts.includes(".aws") || parts.includes("node_modules")) {
    throw new RoomError("protected_path", "Protected paths cannot be reserved.");
  }
  const normalized = relativeKey(parts.join("/"));
  return prefix ? `${normalized}/**` : normalized;
}

export function selectorBase(selector: string): string {
  return selector.endsWith("/**") ? selector.slice(0, -3) : selector;
}

export function selectorMatches(selector: string, target: string): boolean {
  const base = relativeKey(selectorBase(selector));
  const candidate = relativeKey(target);
  return selector.endsWith("/**") ? candidate === base || candidate.startsWith(`${base}/`) : candidate === base;
}

export function selectorsOverlap(left: string, right: string): boolean {
  return selectorMatches(left, selectorBase(right)) || selectorMatches(right, selectorBase(left));
}

function relativePath(root: string, absolute: string): string {
  return relativeKey(path.relative(root, absolute));
}

function assertPathChain(root: string, relative: string): string {
  const absolute = path.resolve(root, ...relative.split("/"));
  if (!isUnder(root, absolute)) throw new RoomError("invalid_path", "Path escapes the repository root.");
  let existing = root;
  for (const part of relative.split("/")) {
    const current = path.join(existing, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new RoomError("path_identity", "Symlink or junction paths are not allowed.");
    if (process.platform === "win32" && (stat.isDirectory() || stat.isFile())) {
      const real = fs.realpathSync.native(current);
      if (pathKey(real) !== pathKey(current)) throw new RoomError("path_identity", "Junction or redirected paths are not allowed.");
    }
    existing = current;
  }
  const realCurrent = fs.realpathSync.native(existing);
  if (!isUnder(fs.realpathSync.native(root), realCurrent)) throw new RoomError("path_identity", "Path realpath escapes the repository root.");
  return absolute;
}

function identityFor(absolute: string): FileIdentity | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || stat.isDirectory()) throw new RoomError("path_identity", "Mutation targets must be regular files without links.");
  if (stat.nlink > 1) throw new RoomError("path_identity", "Hard-linked files are not supported.");
  return {
    realpath: fs.realpathSync.native(absolute),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    nlink: Number(stat.nlink),
  };
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  if (pathKey(left.realpath) !== pathKey(right.realpath)) return false;
  if (left.dev && right.dev && left.dev !== right.dev) return false;
  if (left.ino && right.ino && left.ino !== right.ino) return false;
  return right.nlink <= 1;
}

function fingerprintAbsolute(absolute: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new RoomError("path_identity", "Only regular, non-linked files can be mutated.");
  if (stat.size > MAX_CONTENT_BYTES * 8) throw new RoomError("file_too_large", "Fingerprint target is too large.");
  return createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
}

function fingerprintAt(root: string, relative: string): { fingerprint: string | null; identity?: FileIdentity } {
  const absolute = assertPathChain(root, relative);
  const identity = identityFor(absolute);
  return { fingerprint: fingerprintAbsolute(absolute), ...(identity ? { identity } : {}) };
}

function scanSelector(root: string, selector: string): { fingerprints: Record<string, string | null>; identities: Record<string, FileIdentity> } {
  const base = selectorBase(selector);
  if (!selector.endsWith("/**")) {
    const target = fingerprintAt(root, base);
    return {
      fingerprints: { [base]: target.fingerprint },
      identities: target.identity ? { [base]: target.identity } : {},
    };
  }
  const baseAbsolute = assertPathChain(root, base);
  if (!fs.existsSync(baseAbsolute)) return { fingerprints: {}, identities: {} };
  if (!fs.statSync(baseAbsolute).isDirectory()) throw new RoomError("invalid_path", "Prefix selectors must target a directory.");
  const fingerprints: Record<string, string | null> = {};
  const identities: Record<string, FileIdentity> = {};
  const pending = [baseAbsolute];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new RoomError("path_identity", "Prefix selectors cannot contain symlinks or junctions.");
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      const relative = relativePath(root, absolute);
      const target = fingerprintAt(root, relative);
      fingerprints[relative] = target.fingerprint;
      if (target.identity) identities[relative] = target.identity;
      count += 1;
      if (count > MAX_SCAN_FILES) throw new RoomError("scan_limit", "Prefix selector contains too many files.");
    }
  }
  return { fingerprints, identities };
}

function assertSelectorOutsideRoom(identity: ProjectIdentity, selector: string): void {
  const relativeRoom = relativePath(identity.root, identity.roomDir);
  if (!relativeRoom || relativeRoom === "." || relativeRoom.startsWith("..") || path.isAbsolute(relativeRoom)) return;
  const roomSelector = `${relativeRoom}/**`;
  if (selectorsOverlap(selector, roomSelector)) throw new RoomError("protected_path", "The room state directory cannot be reserved.");
}

async function isDirty(root: string, selector: string): Promise<boolean> {
  const result = await command(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", selectorBase(selector)]);
  if (result.code !== 0) throw new RoomError("git_status", result.stderr.trim() || "Unable to inspect Git status.");
  return Boolean(result.stdout.trim());
}

async function readHead(root: string): Promise<{ branch?: string; oid?: string }> {
  const [branch, oid] = await Promise.all([
    command(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    command(root, ["rev-parse", "HEAD"]),
  ]);
  return {
    ...(branch.code === 0 && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
    ...(oid.code === 0 && oid.stdout.trim() ? { oid: oid.stdout.trim() } : {}),
  };
}

function parseNulPaths(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

function normalizeGitPath(value: string): string {
  const raw = value.replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.startsWith("//") || raw.split("/").some((part) => part === "..")) {
    throw new RoomError("git_path", "Git returned an invalid repository-relative path.");
  }
  return relativeKey(raw.split("/").filter((part) => part && part !== ".").join("/"));
}

function statusPathsFromOutput(stdout: string): string[] {
  const paths: string[] = [];
  for (const entry of parseNulPaths(stdout)) {
    const status = entry.slice(0, 2);
    if (status.includes("R") || status.includes("C")) throw new RoomError("foreign_change", "Rename and copy changes are not supported by the collaboration gate.");
    const relative = entry.slice(3);
    if (relative) paths.push(normalizeGitPath(relative));
  }
  return paths;
}

async function gitStagedPaths(root: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const result = await command(root, ["diff", "--cached", "--name-only", "-z", "--"], 8_000, env);
  if (result.code !== 0) throw new RoomError("git_index", result.stderr.trim() || "Unable to inspect the Git index.");
  return parseNulPaths(result.stdout).map((relative) => normalizeGitPath(relative));
}

function truncateOutput(value: string): string {
  const max = 64 * 1024;
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  return `${value.slice(0, max)}\n[output truncated]`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function selectorCovers(leaseSelector: string, requestedSelector: string): boolean {
  return selectorMatches(leaseSelector, selectorBase(requestedSelector));
}

function pathCoveredByAny(selectors: string[], relative: string): boolean {
  return selectors.some((selector) => selectorMatches(selector, relative));
}

function basenameLower(value: string): string {
  return path.basename(value.replace(/\\/g, "/")).toLowerCase();
}

function checkExecutable(check: CollaborationCheck): string {
  const executable = process.platform === "win32" && check.file.trim().toLowerCase() === "npm" ? "npm.cmd" : check.file.trim();
  if (basenameLower(executable) === "git" || basenameLower(executable) === "git.exe") {
    throw new RoomError("invalid_check", "Git is not an allowed check executable.");
  }
  return executable;
}

function checkEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_EDITOR = "true";
  return env;
}

function shellSafeJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c");
}

function hookWrapperSource(originalPath: string | undefined, guardPath: string, guardAfter: boolean): string {
  const original = originalPath
    ? `const runHook = (file, args) => { const firstLine = readFileSync(file, "utf8").split(/\\r?\\n/, 1)[0] ?? ""; if (/node(?:\\.exe)?\\s*$/i.test(firstLine)) return spawnSync(process.execPath, [file, ...args], { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true }); if (/(?:sh|bash|zsh)(?:\\.exe)?\\s*$/i.test(firstLine)) return spawnSync("sh", [file, ...args], { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true }); return spawnSync(file, args, { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" && /\\.(?:cmd|bat)$/i.test(file) }); };\nconst original = runHook(${shellSafeJson(originalPath)}, process.argv.slice(2));\nif (original.error || (original.status ?? 1) !== 0) process.exit(original.status ?? 1);`
    : "";
  const guard = guardAfter ? `const guard = spawnSync(process.execPath, [${shellSafeJson(guardPath)}], { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true });\nif (guard.error || guard.status !== 0) process.exit(71);\n` : "";
  return `#!/usr/bin/env node\nconst { readFileSync } = require("node:fs");\nconst { spawnSync } = require("node:child_process");\n${original}\n${guard}`;
}

function hookGuardScript(expectedHead: string, expectedBranch: string, expectedRefs: string, selectors: string[]): string {
  return `import { execFileSync } from "node:child_process";\nimport { createHash } from "node:crypto";\nconst env = process.env;\nconst cwd = process.cwd();\nconst run = (args) => { try { return execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true }); } catch (error) { if (error && typeof error === "object" && "stdout" in error) return String(error.stdout ?? ""); throw error; } };\nconst head = run(["rev-parse", "HEAD"]).trim();\nconst branch = (() => { try { return run(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(); } catch { return ""; } })();\nconst refs = run(["for-each-ref", "--format=%(refname)%00%(objectname)%00"]);\nconst staged = run(["diff", "--cached", "--name-only", "-z", "--"]).split("\\0").filter(Boolean);\nconst selectors = ${shellSafeJson(selectors)};\nconst covered = (relative) => selectors.some((selector) => selector.endsWith("/**") ? relative === selector.slice(0, -3) || relative.startsWith(selector.slice(0, -3) + "/") : relative === selector);\nif (head !== ${shellSafeJson(expectedHead)} || branch !== ${shellSafeJson(expectedBranch)} || createHash("sha256").update(refs, "utf8").digest("hex") !== ${shellSafeJson(expectedRefs)} || staged.some((relative) => !covered(relative))) process.exit(71);\n`;
}

type GateScan = {
  head: { branch?: string; oid?: string };
  indexFingerprint: string;
  worktreeFingerprint: string;
  refFingerprint: string;
  refs: string;
  statusPaths: string[];
  fileFingerprints: Record<string, string | null>;
};

function refEntries(value: string): Map<string, string> {
  const entries = value.split("\0").filter(Boolean);
  const refs = new Map<string, string>();
  for (let index = 0; index + 1 < entries.length; index += 2) refs.set(entries[index]!, entries[index + 1]!);
  return refs;
}

async function gitIndexFingerprint(root: string): Promise<string> {
  const result = await command(root, ["rev-parse", "--git-path", "index"]);
  if (result.code !== 0) throw new RoomError("git_index", result.stderr.trim() || "Unable to locate the Git index.");
  const indexPath = path.resolve(root, result.stdout.trim());
  try {
    return createHash("sha256").update(fs.readFileSync(indexPath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return hashText("");
    throw error;
  }
}

async function scanGitState(root: string): Promise<GateScan> {
  const [head, status, staged, unstaged, refs] = await Promise.all([
    readHead(root),
    command(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
    command(root, ["diff", "--cached", "--raw", "-z", "--"]),
    command(root, ["diff", "--raw", "-z", "--"]),
    command(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
  ]);
  const indexFingerprint = await gitIndexFingerprint(root);
  if (status.code !== 0) throw new RoomError("git_status", status.stderr.trim() || "Unable to inspect Git status.");
  if (staged.code !== 0 || unstaged.code !== 0 || refs.code !== 0) {
    throw new RoomError("git_state", [staged.stderr, unstaged.stderr, refs.stderr].map((text) => text.trim()).find(Boolean) || "Unable to inspect the complete Git state.");
  }
  const statusPaths = statusPathsFromOutput(status.stdout);
  const fileFingerprints: Record<string, string | null> = {};
  for (const relative of statusPaths) fileFingerprints[relative] = fingerprintAt(root, relative).fingerprint;
  const fingerprintRows = Object.entries(fileFingerprints).sort(([left], [right]) => relativeKey(left).localeCompare(relativeKey(right)));
  return {
    head,
    indexFingerprint,
    worktreeFingerprint: hashText(`${status.stdout}\0${unstaged.stdout}\0${JSON.stringify(fingerprintRows)}`),
    refFingerprint: hashText(refs.stdout),
    refs: refs.stdout,
    statusPaths,
    fileFingerprints,
  };
}

function changedGatePaths(before: GateScan, after: GateScan): string[] {
  const paths = new Set([...Object.keys(before.fileFingerprints), ...Object.keys(after.fileFingerprints)]);
  return [...paths].filter((relative) => (before.fileFingerprints[relative] ?? null) !== (after.fileFingerprints[relative] ?? null));
}

function emptySnapshot(projectKey: string): RoomSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    projectKey,
    epoch: 0,
    seq: 0,
    head: {},
    sessions: {},
    tasks: {},
    leases: {},
    pendingAsks: [],
    activity: [],
    updatedAt: now(),
  };
}

function loadSnapshot(identity: ProjectIdentity): RoomSnapshot {
  if (!fs.existsSync(identity.snapshotPath)) return emptySnapshot(identity.projectKey);
  try {
    const parsed = JSON.parse(fs.readFileSync(identity.snapshotPath, "utf8")) as RoomSnapshot;
    if (
      parsed.schema !== SNAPSHOT_SCHEMA ||
      parsed.projectKey !== identity.projectKey ||
      !parsed.head ||
      !parsed.sessions ||
      Array.isArray(parsed.sessions) ||
      !parsed.tasks ||
      Array.isArray(parsed.tasks) ||
      !parsed.leases ||
      Array.isArray(parsed.leases) ||
      !Array.isArray(parsed.activity)
    ) {
      throw new Error("invalid snapshot shape");
    }
    return { ...parsed, pendingAsks: Array.isArray(parsed.pendingAsks) ? parsed.pendingAsks : [] };
  } catch (error) {
    throw new RoomError("snapshot_corrupt", `Room snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function persistJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function activeLease(state: LeaseState): boolean {
  return state === "active" || state === "dirty" || state === "invalid" || state === "orphaned";
}

function validateRpcRequest(value: unknown): RpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoomError("invalid_request", "Request must be an object.");
  const request = value as Partial<RpcRequest>;
  if (typeof request.id !== "string" || request.id.length > 100 || typeof request.method !== "string" || request.method.length > 80) {
    throw new RoomError("invalid_request", "Request id and method are invalid.");
  }
  if (typeof request.epoch !== "number" || !Number.isSafeInteger(request.epoch) || typeof request.sessionId !== "string" || typeof request.connectionId !== "string") {
    throw new RoomError("invalid_request", "Request identity is invalid.");
  }
  return request as RpcRequest;
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoomError("invalid_payload", "Payload must be an object.");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new RoomError("invalid_payload", `${label} is invalid.`);
  return value;
}

function requireMessage(value: unknown): string {
  const message = requireString(value, "message", MAX_MESSAGE_BYTES);
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) throw new RoomError("invalid_payload", "message is too large.");
  return message;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(identity: ProjectIdentity): LockRecord | undefined {
  try {
    const lock = JSON.parse(fs.readFileSync(identity.lockPath, "utf8")) as LockRecord;
    if (lock.schema !== 1 || !Number.isInteger(lock.pid) || typeof lock.connectionId !== "string" || !Number.isInteger(lock.epoch) || typeof lock.heartbeatAt !== "string") return undefined;
    return lock;
  } catch {
    return undefined;
  }
}

function lockFileExists(identity: ProjectIdentity): boolean {
  return fs.existsSync(identity.lockPath);
}

function staleLock(identity: ProjectIdentity): boolean {
  const lock = readLock(identity);
  if (!lock) return lockFileExists(identity);
  return !processIsAlive(lock.pid);
}

function takeOverStaleLock(identity: ProjectIdentity): boolean {
  if (!staleLock(identity)) return false;
  const moved = `${identity.lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(identity.lockPath, moved);
    fs.rmSync(moved, { force: true });
    return true;
  } catch {
    return false;
  }
}

class JsonRpcChannel {
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new RoomError("room_disconnected", "Coordinator connection closed.")));
  }

  static connect(socketPath: string, timeoutMs = 1_500): Promise<JsonRpcChannel> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RoomError("room_unavailable", "Coordinator connection timed out."));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new JsonRpcChannel(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(request: RpcRequest, timeoutMs = 5_000): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new RoomError("room_timeout", `Coordinator request '${request.method}' timed out.`));
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      try {
        this.socket.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.socket.destroy();
    this.fail(new RoomError("room_disconnected", "Coordinator connection closed."));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_BYTES) {
      this.close();
      return;
    }
    while (true) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as RpcResponse;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.resolve(response);
      } catch {
        this.close();
        return;
      }
    }
  }

  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

class Coordinator {
  private lockFd = -1;
  private readonly lockConnectionId = randomUUID();
  private server: net.Server | undefined;
  private lockTimer: NodeJS.Timeout | undefined;
  private fencingSequence = 1;
  private operationTail: Promise<void> = Promise.resolve();
  private state: RoomSnapshot;
  private refFingerprint = "";
  private readonly socketConnections = new Map<net.Socket, { sessionId: string; connectionId: string } | undefined>();
  private readonly sessionSockets = new Map<string, net.Socket>();
  private closeGeneration = 0;
  private closing = false;
  private readonly inboxes = new Map<string, RoomMessage[]>();
  private readonly pendingAsks = new Map<string, { fromSessionId: string; toSessionId: string; expiresAt: number }>();
  private readonly messageRates = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly identity: ProjectIdentity,
    private readonly config: CollaborationConfig,
  ) {
    this.state = emptySnapshot(identity.projectKey);
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.identity.roomDir, { recursive: true, mode: 0o700 });
    try {
      this.lockFd = fs.openSync(this.identity.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LockHeldError();
      throw error;
    }
    try {
      this.writeLock();
      this.state = loadSnapshot(this.identity);
      this.pendingAsks.clear();
      this.state.pendingAsks = [];
      this.state.epoch += 1;
      for (const session of Object.values(this.state.sessions)) session.state = "offline";
      for (const lease of Object.values(this.state.leases)) {
        if (activeLease(lease.state)) lease.state = "orphaned";
      }
      this.fencingSequence = Math.max(1, ...Object.values(this.state.leases).map((lease) => lease.fencingToken + 1));
      const currentGitState = await scanGitState(this.identity.root);
      this.state.head = currentGitState.head;
      this.state.refFingerprint = currentGitState.refFingerprint;
      this.refFingerprint = currentGitState.refFingerprint;
      this.clearOfflineGitQuarantine();
      this.writeLock();
      if (process.platform !== "win32") fs.rmSync(this.identity.socketPath, { force: true });
      this.server = net.createServer((socket) => this.handleSocket(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.identity.socketPath, () => resolve());
      });
      this.lockTimer = setInterval(() => {
        try {
          this.renewConnectedLeases();
          this.expireCleanLeases();
          this.expireAsks();
          this.writeLock();
          this.persist();
        } catch {
          // A failed heartbeat makes takeover conservative; mutations still fail on RPC.
        }
      }, Math.max(500, Math.floor(this.config.heartbeatMs)));
      this.persist();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.closeGeneration += 1;
    const ownedLock = this.lockFd >= 0;
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.lockTimer = undefined;
    for (const socket of this.socketConnections.keys()) socket.destroy();
    this.socketConnections.clear();
    this.sessionSockets.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    if (ownedLock && process.platform !== "win32") fs.rmSync(this.identity.socketPath, { force: true });
    if (this.lockFd >= 0) {
      try { fs.closeSync(this.lockFd); } catch { /* already closed */ }
      this.lockFd = -1;
    }
    if (ownedLock) {
      const lock = readLock(this.identity);
      if (lock?.pid === process.pid && lock.connectionId === this.lockConnectionId) {
        fs.rmSync(this.identity.lockPath, { force: true });
      }
    }
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const operation = this.operationTail.then(task, task);
    this.operationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async invoke(request: RpcRequest): Promise<RpcResponse> {
    return this.enqueue(() => this.invokeSerial(request));
  }

  private async invokeSerial(request: RpcRequest): Promise<RpcResponse> {
    try {
      const valid = validateRpcRequest(request);
      const result = await this.handle(valid);
      return { id: valid.id, ok: true, result: clone(result) };
    } catch (error) {
      const roomError = error instanceof RoomError ? error : new RoomError("internal", error instanceof Error ? error.message : String(error));
      return { id: request.id, ok: false, error: { code: roomError.code, message: roomError.message, details: roomError.details } };
    }
  }

  private handleSocket(socket: net.Socket): void {
    this.socketConnections.set(socket, undefined);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RPC_BYTES) {
        socket.destroy();
        return;
      }
      while (true) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        void this.handleLine(socket, line);
      }
    });
    socket.on("close", () => {
      const connection = this.socketConnections.get(socket);
      this.socketConnections.delete(socket);
      if (!connection) return;
      void this.enqueue(() => this.markDisconnected(connection.sessionId, socket));
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: RpcRequest;
    try {
      request = validateRpcRequest(JSON.parse(line));
    } catch (error) {
      socket.destroy();
      return;
    }
    const response = await this.invoke(request);
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
    if (request.method === "join" && response.ok) {
      this.socketConnections.set(socket, { sessionId: request.sessionId, connectionId: request.connectionId });
      this.sessionSockets.set(request.sessionId, socket);
    }
  }

  private async handle(request: RpcRequest): Promise<unknown> {
    if (request.method === "join") return this.join(request);
    const session = this.state.sessions[request.sessionId];
    if (!session || session.connectionId !== request.connectionId || session.state === "offline") {
      throw new RoomError("session_not_joined", "Session is not connected to this room.");
    }
    if (request.epoch !== this.state.epoch) throw new RoomError("stale_epoch", "Room epoch changed; reconnect is required.", { epoch: this.state.epoch });
    switch (request.method) {
      case "heartbeat": return this.heartbeat(request.sessionId, payloadObject(request.payload ?? {}));
      case "leave": return this.leave(request.sessionId);
      case "status": return this.status();
      case "claim": return this.claim(request.sessionId, payloadObject(request.payload));
      case "reserve": return this.reserve(request.sessionId, payloadObject(request.payload));
      case "release": return this.release(request.sessionId, payloadObject(request.payload));
      case "mutate_write": return this.mutate(request.sessionId, payloadObject(request.payload), "write");
      case "mutate_edit": return this.mutate(request.sessionId, payloadObject(request.payload), "edit");
      case "check": return this.check(request.sessionId, payloadObject(request.payload));
      case "commit": return this.commit(request.sessionId, payloadObject(request.payload));
      case "inbox": return this.inbox(request.sessionId);
      case "send": return this.send(request.sessionId, payloadObject(request.payload));
      case "ask": return this.ask(request.sessionId, payloadObject(request.payload));
      case "reply": return this.reply(request.sessionId, payloadObject(request.payload));
      default: throw new RoomError("unknown_method", `Unknown room method '${request.method}'.`);
    }
  }

  private join(request: RpcRequest): RoomSnapshot {
    const payload = payloadObject(request.payload);
    const sessionId = requireString(payload.sessionId ?? request.sessionId, "sessionId", 200);
    const connectionId = requireString(payload.connectionId ?? request.connectionId, "connectionId", 200);
    if (sessionId !== request.sessionId || connectionId !== request.connectionId) throw new RoomError("invalid_payload", "Join identity does not match the request.");
    const displayName = safeName(typeof payload.displayName === "string" ? payload.displayName : "LeafCode session", "LeafCode session");
    const timestamp = now();
    const previous = this.state.sessions[sessionId];
    if (previous && previous.connectionId !== connectionId) {
      for (const lease of Object.values(this.state.leases)) {
        if (lease.ownerSessionId === sessionId && activeLease(lease.state)) lease.state = "orphaned";
      }
      this.dropSessionMessages(sessionId);
    }
    this.state.sessions[sessionId] = {
      sessionId,
      connectionId,
      displayName,
      pid: typeof payload.pid === "number" && Number.isInteger(payload.pid) ? payload.pid : 0,
      state: "active",
      currentPaths: [],
      joinedAt: previous?.joinedAt ?? timestamp,
      lastHeartbeatAt: timestamp,
      lastProgressAt: timestamp,
    };
    if (!previous || previous.connectionId === connectionId) {
      for (const lease of Object.values(this.state.leases)) {
        if (lease.ownerSessionId !== sessionId || lease.state !== "orphaned") continue;
        try {
          this.validateLease(lease);
        } catch {
          continue;
        }
        this.refreshLeaseState(lease);
        if (lease.state !== "active" && lease.state !== "dirty") continue;
        lease.epoch = this.state.epoch;
        lease.fencingToken = this.fencingSequence++;
        lease.renewedAt = timestamp;
        lease.expiresAt = new Date(Date.now() + this.config.leaseTtlMs).toISOString();
        this.touch("reserve", sessionId, lease.selectors);
      }
    }
    this.touch("join", sessionId, []);
    return this.state;
  }

  private clearOfflineGitQuarantine(): void {
    if (this.state.compromised?.reason !== OFFLINE_GIT_CHANGE_REASON) return;
    delete this.state.compromised;
  }

  private heartbeat(sessionId: string, payload: Record<string, unknown>): RoomSnapshot {
    const session = this.state.sessions[sessionId]!;
    const timestamp = now();
    session.lastHeartbeatAt = timestamp;
    if (session.state === "offline") session.state = "active";
    if (payload.state !== undefined) {
      if (payload.state !== "active" && payload.state !== "idle" && payload.state !== "away" && payload.state !== "stuck") {
        throw new RoomError("invalid_payload", "Presence state is invalid.");
      }
      session.state = payload.state;
    }
    if (payload.currentTool !== undefined) {
      if (payload.currentTool === null) session.currentTool = undefined;
      else session.currentTool = requireString(payload.currentTool, "currentTool", 120);
    }
    if (payload.currentPaths !== undefined) {
      if (!Array.isArray(payload.currentPaths) || payload.currentPaths.length > MAX_SELECTOR_COUNT) throw new RoomError("invalid_payload", "currentPaths is invalid.");
      session.currentPaths = payload.currentPaths.map((value) => normalizeSelector(value)).filter((value) => !value.endsWith("/**"));
    }
    if (payload.progress === true) session.lastProgressAt = timestamp;
    if (session.state !== "away" && Date.now() - Date.parse(session.lastProgressAt) >= this.config.stuckAfterMs) session.state = "stuck";
    this.renewConnectedLeases();
    this.validateActiveLeases();
    this.expireCleanLeases();
    this.clearOfflineGitQuarantine();
    this.touch("heartbeat", sessionId, []);
    return this.state;
  }

  private async markDisconnected(sessionId: string, socket?: net.Socket): Promise<void> {
    if (socket && this.sessionSockets.get(sessionId) !== socket) return;
    if (socket && this.sessionSockets.get(sessionId) === socket) this.sessionSockets.delete(sessionId);
    const session = this.state.sessions[sessionId];
    if (!session || session.state === "offline") return;
    session.state = "offline";
    for (const lease of Object.values(this.state.leases)) {
      if (lease.ownerSessionId === sessionId && activeLease(lease.state)) lease.state = "orphaned";
    }
    this.dropSessionMessages(sessionId);
    this.touch("leave", sessionId, []);
    if (!Object.values(this.state.sessions).some((entry) => entry.state !== "offline")) await this.close();
  }

  private scheduleCloseIfIdle(): void {
    if (Object.values(this.state.sessions).some((entry) => entry.state !== "offline")) return;
    this.closeGeneration += 1;
    const generation = this.closeGeneration;
    setTimeout(() => {
      void this.enqueue(async () => {
        if (generation !== this.closeGeneration) return;
        if (Object.values(this.state.sessions).some((entry) => entry.state !== "offline")) return;
        await this.close();
      });
    }, 0).unref?.();
  }

  private leave(sessionId: string): RoomSnapshot {
    const session = this.state.sessions[sessionId]!;
    session.state = "offline";
    this.sessionSockets.delete(sessionId);
    for (const lease of Object.values(this.state.leases)) {
      if (lease.ownerSessionId !== sessionId) continue;
      if (lease.state === "active") lease.state = "released";
      else if (activeLease(lease.state)) lease.state = "orphaned";
    }
    this.dropSessionMessages(sessionId);
    this.touch("leave", sessionId, []);
    this.scheduleCloseIfIdle();
    return this.state;
  }

  private status(): RoomSnapshot {
    this.renewConnectedLeases();
    this.validateActiveLeases();
    this.expireCleanLeases();
    this.expireAsks();
    this.persist();
    return this.state;
  }

  private peerSession(sessionId: string, value: unknown): SessionPresence {
    const peerId = requireString(value, "to", 200);
    if (peerId === sessionId) throw new RoomError("invalid_payload", "Messages must target another session.");
    const peer = this.state.sessions[peerId];
    if (!peer || peer.state === "offline") throw new RoomError("peer_unavailable", "Target session is not connected.", { sessionId: peerId });
    return peer;
  }

  private consumeMessageRate(sessionId: string): void {
    const timestamp = Date.now();
    const current = this.messageRates.get(sessionId);
    if (!current || timestamp - current.startedAt >= MESSAGE_RATE_WINDOW_MS) {
      this.messageRates.set(sessionId, { startedAt: timestamp, count: 1 });
      return;
    }
    if (current.count >= MAX_MESSAGES_PER_WINDOW) {
      throw new RoomError("rate_limited", "Peer message rate limit exceeded.", { retryAfterMs: MESSAGE_RATE_WINDOW_MS - (timestamp - current.startedAt) });
    }
    current.count += 1;
  }

  private expireAsks(): void {
    const timestamp = Date.now();
    const expired = new Set<string>();
    for (const [requestId, ask] of this.pendingAsks) {
      if (ask.expiresAt <= timestamp) {
        this.pendingAsks.delete(requestId);
        expired.add(requestId);
      }
    }
    if (!expired.size) return;
    for (const [sessionId, queue] of this.inboxes) {
      const remaining = queue.filter((message) => message.kind !== "ask" || !message.requestId || !expired.has(message.requestId));
      if (remaining.length) this.inboxes.set(sessionId, remaining);
      else this.inboxes.delete(sessionId);
    }
  }

  private queueMessage(message: RoomMessage): void {
    const queue = this.inboxes.get(message.toSessionId) ?? [];
    if (queue.length >= MAX_INBOX_MESSAGES) throw new RoomError("inbox_full", "Target session inbox is full.");
    queue.push(message);
    this.inboxes.set(message.toSessionId, queue);
  }

  private dropSessionMessages(sessionId: string): void {
    this.inboxes.delete(sessionId);
    this.messageRates.delete(sessionId);
    for (const [requestId, ask] of this.pendingAsks) {
      if (ask.fromSessionId === sessionId || ask.toSessionId === sessionId) this.pendingAsks.delete(requestId);
    }
  }

  private inbox(sessionId: string): RoomMessage[] {
    this.expireAsks();
    const queue = this.inboxes.get(sessionId) ?? [];
    const messages: RoomMessage[] = [];
    let responseBytes = 2;
    while (queue.length) {
      const next = queue[0]!;
      const nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8") + 1;
      if (messages.length > 0 && responseBytes + nextBytes > MAX_INBOX_RESPONSE_BYTES) break;
      messages.push(queue.shift()!);
      responseBytes += nextBytes;
    }
    if (queue.length) this.inboxes.set(sessionId, queue);
    else this.inboxes.delete(sessionId);
    this.persist();
    return messages;
  }

  private send(sessionId: string, payload: Record<string, unknown>): RoomMessage {
    const peer = this.peerSession(sessionId, payload.to);
    const text = requireMessage(payload.message);
    this.consumeMessageRate(sessionId);
    const message: RoomMessage = {
      id: randomUUID(),
      kind: "send",
      fromSessionId: sessionId,
      toSessionId: peer.sessionId,
      message: text,
      at: now(),
    };
    this.queueMessage(message);
    this.touch("send", sessionId, []);
    return message;
  }

  private ask(sessionId: string, payload: Record<string, unknown>): AskResult {
    const peer = this.peerSession(sessionId, payload.to);
    const text = requireMessage(payload.message);
    this.consumeMessageRate(sessionId);
    this.expireAsks();
    const requestId = payload.requestId === undefined ? randomUUID() : requireString(payload.requestId, "requestId", 200);
    if (this.pendingAsks.has(requestId)) throw new RoomError("invalid_payload", "requestId is already in use.");
    const expiresAt = Date.now() + this.config.askTimeoutMs;
    this.queueMessage({
      id: randomUUID(),
      kind: "ask",
      fromSessionId: sessionId,
      toSessionId: peer.sessionId,
      requestId,
      message: text,
      at: now(),
    });
    this.pendingAsks.set(requestId, { fromSessionId: sessionId, toSessionId: peer.sessionId, expiresAt });
    this.touch("ask", sessionId, []);
    return { requestId, expiresAt: new Date(expiresAt).toISOString() };
  }

  private reply(sessionId: string, payload: Record<string, unknown>): RoomMessage {
    this.expireAsks();
    const requestId = requireString(payload.requestId, "requestId", 200);
    const pending = this.pendingAsks.get(requestId);
    if (!pending) throw new RoomError("ask_not_found", "Ask request is unknown or expired.");
    if (pending.expiresAt <= Date.now()) {
      this.pendingAsks.delete(requestId);
      throw new RoomError("ask_timeout", "Ask request has expired.");
    }
    if (pending.toSessionId !== sessionId) throw new RoomError("ask_recipient", "Only the ask target can reply.");
    try {
      this.peerSession(sessionId, pending.fromSessionId);
    } catch (error) {
      this.pendingAsks.delete(requestId);
      throw error;
    }
    const text = requireMessage(payload.message);
    this.consumeMessageRate(sessionId);
    const message: RoomMessage = {
      id: randomUUID(),
      kind: "reply",
      fromSessionId: sessionId,
      toSessionId: pending.fromSessionId,
      requestId,
      message: text,
      at: now(),
    };
    this.queueMessage(message);
    this.pendingAsks.delete(requestId);
    this.touch("reply", sessionId, []);
    return message;
  }

  private ensureHealthy(): void {
    if (this.state.compromised) {
      throw new RoomError("compromised", `Room mutation is disabled: ${this.state.compromised.reason}`);
    }
  }

  private markCompromised(reason: string, sessionId: string, paths: string[] = []): void {
    if (!this.state.compromised) this.state.compromised = { reason, at: now() };
    this.touch("compromised", sessionId, paths);
  }

  private claim(sessionId: string, payload: Record<string, unknown>): TaskClaim {
    const title = requireString(payload.title, "title");
    const taskId = typeof payload.taskId === "string" && payload.taskId.trim() ? payload.taskId.trim().slice(0, 200) : randomUUID();
    const existing = this.state.tasks[taskId];
    if (existing && existing.ownerSessionId !== sessionId && existing.status !== "done") throw new RoomError("task_conflict", "Task is already claimed by another session.");
    const task: TaskClaim = {
      id: taskId,
      ownerSessionId: sessionId,
      title,
      ...(typeof payload.goal === "string" && payload.goal.trim() ? { goal: payload.goal.trim().slice(0, 2_000) } : {}),
      leaseIds: existing?.leaseIds ?? [],
      status: "active",
      updatedAt: now(),
    };
    this.state.tasks[taskId] = task;
    this.state.sessions[sessionId]!.taskId = taskId;
    this.state.sessions[sessionId]!.goal = task.goal;
    this.touch("claim", sessionId, []);
    return task;
  }

  private mutableLease(sessionId: string, target: string): FileLease | undefined {
    const matches = Object.values(this.state.leases).filter((lease) =>
      lease.ownerSessionId === sessionId &&
      (lease.state === "active" || lease.state === "dirty") &&
      lease.epoch === this.state.epoch &&
      lease.selectors.some((selector) => selectorMatches(selector, target)),
    );
    if (matches.length <= 1) return matches[0];
    return matches.sort((left, right) => Date.parse(right.renewedAt) - Date.parse(left.renewedAt))[0];
  }

  private renewConnectedLeases(): void {
    const timestamp = now();
    const expiresAt = new Date(Date.now() + this.config.leaseTtlMs).toISOString();
    for (const lease of Object.values(this.state.leases)) {
      if (lease.state !== "active" && lease.state !== "dirty") continue;
      if (lease.epoch !== this.state.epoch) continue;
      const owner = this.state.sessions[lease.ownerSessionId];
      if (!owner || owner.state === "offline") continue;
      lease.renewedAt = timestamp;
      lease.expiresAt = expiresAt;
    }
  }

  private requireMutableLease(sessionId: string, target: string): FileLease {
    const lease = this.mutableLease(sessionId, target);
    if (lease) return lease;
    const covering = Object.values(this.state.leases).filter((entry) =>
      entry.selectors.some((selector) => selectorMatches(selector, target)),
    );
    const own = covering.find((entry) => entry.ownerSessionId === sessionId);
    if (own) {
      throw new RoomError(
        "lease_required",
        `Lease for '${target}' is '${own.state}'; call leafcode_collab reserve again.`,
        { path: target, leaseId: own.id, state: own.state },
      );
    }
    const other = covering.find((entry) => activeLease(entry.state));
    if (other) {
      throw new RoomError(
        "lease_required",
        `Path '${target}' is reserved by another session's lease.`,
        { path: target, leaseId: other.id, ownerSessionId: other.ownerSessionId },
      );
    }
    throw new RoomError("lease_required", `An active lease covering '${target}' is required.`);
  }

  private selectorsCoveredByLease(selectors: string[], lease: FileLease): boolean {
    return selectors.every((selector) => lease.selectors.some((owned) => selectorCovers(owned, selector)));
  }

  private releaseOwnOrphanedLeases(sessionId: string, selectors: string[]): void {
    for (const lease of Object.values(this.state.leases)) {
      if (lease.ownerSessionId !== sessionId || lease.state !== "orphaned") continue;
      if (!selectors.some((selector) => lease.selectors.some((owned) => selectorsOverlap(selector, owned)))) continue;
      lease.state = "released";
      lease.renewedAt = now();
      this.touch("release", sessionId, lease.selectors);
    }
  }

  private async tryReclaimOrphanedLease(sessionId: string, selectors: string[]): Promise<FileLease | undefined> {
    const candidates = Object.values(this.state.leases).filter((lease) =>
      lease.ownerSessionId === sessionId &&
      lease.state === "orphaned" &&
      this.selectorsCoveredByLease(selectors, lease),
    );
    if (candidates.length !== 1) return undefined;
    const lease = candidates[0]!;
    try {
      this.validateLease(lease);
    } catch {
      lease.state = "released";
      this.touch("release", sessionId, lease.selectors);
      return undefined;
    }
    this.refreshLeaseState(lease);
    if (lease.state !== "active" && lease.state !== "dirty") return undefined;
    lease.epoch = this.state.epoch;
    lease.fencingToken = this.fencingSequence++;
    lease.renewedAt = now();
    lease.expiresAt = new Date(Date.now() + this.config.leaseTtlMs).toISOString();
    this.releaseOwnOrphanedLeases(sessionId, selectors);
    this.touch("reserve", sessionId, lease.selectors);
    return lease;
  }

  private async reserve(sessionId: string, payload: Record<string, unknown>): Promise<FileLease> {
    this.ensureHealthy();
    if (!Array.isArray(payload.paths) || payload.paths.length < 1 || payload.paths.length > MAX_SELECTOR_COUNT) throw new RoomError("invalid_payload", "reserve requires 1-64 paths.");
    const selectors = [...new Set(payload.paths.map((value) => normalizeSelector(value)))];
    for (const selector of selectors) assertSelectorOutsideRoom(this.identity, selector);
    const reclaimed = await this.tryReclaimOrphanedLease(sessionId, selectors);
    if (reclaimed) return reclaimed;
    for (const lease of Object.values(this.state.leases)) {
      if (!activeLease(lease.state) || lease.ownerSessionId === sessionId) continue;
      if (selectors.some((selector) => lease.selectors.some((other) => selectorsOverlap(selector, other)))) {
        throw new RoomError("lease_conflict", "Requested paths overlap another active or orphaned lease.", { leaseId: lease.id, ownerSessionId: lease.ownerSessionId });
      }
    }
    this.releaseOwnOrphanedLeases(sessionId, selectors);
    const baseline: Record<string, string | null> = {};
    const identities: Record<string, FileIdentity> = {};
    for (const selector of selectors) {
      if (await isDirty(this.identity.root, selector)) throw new RoomError("foreign_change", `Path '${selector}' already has an unowned Git change.`);
      const scanned = scanSelector(this.identity.root, selector);
      Object.assign(baseline, scanned.fingerprints);
      Object.assign(identities, scanned.identities);
    }
    const timestamp = now();
    const lease: FileLease = {
      id: randomUUID(),
      ownerSessionId: sessionId,
      selectors,
      epoch: this.state.epoch,
      fencingToken: this.fencingSequence++,
      state: "active",
      ...(this.state.head.oid ? { acquiredHeadOid: this.state.head.oid } : {}),
      baseline,
      observed: { ...baseline },
      identities,
      acquiredAt: timestamp,
      renewedAt: timestamp,
      expiresAt: new Date(Date.now() + this.config.leaseTtlMs).toISOString(),
    };
    this.state.leases[lease.id] = lease;
    this.touch("reserve", sessionId, selectors);
    return lease;
  }

  private release(sessionId: string, payload: Record<string, unknown>): FileLease {
    this.ensureHealthy();
    const leaseId = requireString(payload.leaseId, "leaseId", 100);
    const lease = this.state.leases[leaseId];
    if (!lease || lease.ownerSessionId !== sessionId) throw new RoomError("lease_not_owned", "Lease is not owned by this session.");
    if (lease.state !== "active") throw new RoomError("lease_not_clean", `Lease cannot be released from state '${lease.state}'.`);
    lease.state = "released";
    lease.renewedAt = now();
    this.touch("release", sessionId, lease.selectors);
    return lease;
  }

  private async mutate(sessionId: string, payload: Record<string, unknown>, operation: "write" | "edit"): Promise<{ path: string; fingerprint: string; leaseId: string; epoch: number; fencingToken: number }> {
    this.ensureHealthy();
    const target = normalizeSelector(payload.path);
    if (target.endsWith("/**")) throw new RoomError("invalid_path", "Mutation path must be an exact file path.");
    const lease = this.requireMutableLease(sessionId, target);
    if (lease.state !== "active" && lease.state !== "dirty") throw new RoomError("lease_invalid", `Lease is '${lease.state}'.`);
    this.validateLease(lease);
    const current = fingerprintAt(this.identity.root, target);
    const expected = lease.observed[target] ?? null;
    if (current.fingerprint !== expected || !sameIdentity(lease.identities[target], current.identity)) {
      lease.state = "invalid";
      this.touch("lease-invalid", sessionId, [target]);
      throw new RoomError("foreign_change", "Target changed after lease acquisition.");
    }
    let content: string;
    if (operation === "write") {
      if (typeof payload.content !== "string") throw new RoomError("invalid_payload", "content is required.");
      content = payload.content;
    } else {
      const oldText = requireString(payload.oldText, "oldText", MAX_CONTENT_BYTES);
      if (typeof payload.newText !== "string") throw new RoomError("invalid_payload", "newText is required.");
      const absolute = path.resolve(this.identity.root, ...target.split("/"));
      if (!fs.existsSync(absolute)) throw new RoomError("missing_file", "Edit target does not exist.");
      const currentText = fs.readFileSync(absolute, "utf8");
      content = applyUniqueTextEdit(currentText, oldText, payload.newText);
    }
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw new RoomError("content_too_large", "Mutation content is too large.");
    const recheck = fingerprintAt(this.identity.root, target);
    if (recheck.fingerprint !== expected || !sameIdentity(lease.identities[target], recheck.identity)) {
      lease.state = "invalid";
      this.touch("lease-invalid", sessionId, [target]);
      throw new RoomError("foreign_change", "Target changed during mutation preparation.");
    }
    atomicWrite(this.identity.root, target, content, expected, lease.identities[target]);
    const after = fingerprintAt(this.identity.root, target);
    if (!after.fingerprint || !after.identity) {
      lease.state = "invalid";
      throw new RoomError("mutation_failed", "Mutation did not produce a regular file.");
    }
    lease.observed[target] = after.fingerprint;
    lease.identities[target] = after.identity;
    lease.state = "dirty";
    lease.renewedAt = now();
    lease.expiresAt = new Date(Date.now() + this.config.leaseTtlMs).toISOString();
    this.state.sessions[sessionId]!.currentPaths = [target];
    this.touch(operation, sessionId, [target]);
    return { path: target, fingerprint: after.fingerprint, leaseId: lease.id, epoch: lease.epoch, fencingToken: lease.fencingToken };
  }

  private leaseForPath(sessionId: string, target: string): FileLease | undefined {
    return this.mutableLease(sessionId, target);
  }

  private changedPaths(before: GateScan, after: GateScan): string[] {
    return changedGatePaths(before, after);
  }

  private updateLeaseObservation(lease: FileLease, relative: string, fingerprint: string | null): void {
    relative = relativeKey(relative);
    lease.observed[relative] = fingerprint;
    if (fingerprint === null) delete lease.identities[relative];
    else {
      const current = fingerprintAt(this.identity.root, relative);
      if (!current.identity || current.fingerprint !== fingerprint) throw new RoomError("foreign_change", `Unable to verify changed path '${relative}'.`);
      lease.identities[relative] = current.identity;
    }
    lease.renewedAt = now();
    lease.expiresAt = new Date(Date.now() + this.config.leaseTtlMs).toISOString();
  }

  private refreshLeaseState(lease: FileLease): void {
    const keys = new Set([...Object.keys(lease.baseline), ...Object.keys(lease.observed)]);
    lease.state = [...keys].some((relative) => (lease.baseline[relative] ?? null) !== (lease.observed[relative] ?? null)) ? "dirty" : "active";
  }

  private applyCheckChanges(sessionId: string, before: GateScan, after: GateScan): string[] {
    const changed = this.changedPaths(before, after);
    for (const relative of changed) {
      const ownerLease = this.leaseForPath(sessionId, relative);
      const otherLease = Object.values(this.state.leases).find((lease) =>
        lease.ownerSessionId !== sessionId && activeLease(lease.state) && lease.selectors.some((selector) => selectorMatches(selector, relative)),
      );
      if (!ownerLease || otherLease) {
        throw new RoomError("foreign_change", `Check changed an unowned path '${relative}'.`);
      }
      this.updateLeaseObservation(ownerLease, relative, after.fileFingerprints[relative] ?? null);
      ownerLease.state = "dirty";
    }
    return changed;
  }

  private async check(sessionId: string, payload: Record<string, unknown>): Promise<CheckResult> {
    this.ensureHealthy();
    const rawCheckId = requireString(payload.checkId, "checkId", 40);
    if (!(COLLABORATION_CHECK_IDS as readonly string[]).includes(rawCheckId)) throw new RoomError("invalid_check", `Unknown check '${rawCheckId}'.`);
    const checkId = rawCheckId as CollaborationCheckId;
    const check = this.config.checks[checkId];
    const executable = checkExecutable(check);
    const before = await scanGitState(this.identity.root);
    if (before.refFingerprint !== this.refFingerprint || before.head.branch !== this.state.head.branch || before.head.oid !== this.state.head.oid) {
      this.markCompromised("HEAD or refs changed outside the collaboration coordinator.", sessionId);
      throw new RoomError("compromised", "HEAD or refs changed outside the collaboration coordinator.");
    }
    const env = checkEnvironment();
    let execution: CommandResult | undefined;
    let executionError: unknown;
    try {
      execution = await runProgram(executable, check.args, this.identity.root, CHECK_TIMEOUT_MS, env);
    } catch (error) {
      executionError = error;
    }
    const after = await scanGitState(this.identity.root);
    if (after.head.branch !== before.head.branch || after.head.oid !== before.head.oid || after.refFingerprint !== before.refFingerprint) {
      this.markCompromised("The check changed HEAD or Git refs.", sessionId);
      throw new RoomError("compromised", "The check changed HEAD or Git refs; all mutation is disabled.");
    }
    if (after.indexFingerprint !== before.indexFingerprint) {
      throw new RoomError("foreign_change", "The check changed the shared Git index.");
    }
    const changed = this.applyCheckChanges(sessionId, before, after);
    this.touch("check", sessionId, changed);
    if (executionError) throw new RoomError("check_failed", executionError instanceof Error ? executionError.message : String(executionError));
    if (!execution) throw new RoomError("check_failed", "Check did not produce a result.");
    return {
      checkId,
      code: execution.code,
      stdout: truncateOutput(execution.stdout),
      stderr: truncateOutput(execution.stderr),
    };
  }

  private async assertHeadConflict(lease: FileLease, headOid: string | undefined): Promise<void> {
    if (!lease.acquiredHeadOid || !headOid || lease.acquiredHeadOid === headOid) return;
    const result = await command(this.identity.root, ["diff", "--name-only", "-z", `${lease.acquiredHeadOid}..${headOid}`, "--"]);
    if (result.code !== 0) throw new RoomError("head_conflict", result.stderr.trim() || "Unable to compare the lease base with HEAD.");
    const changed = parseNulPaths(result.stdout).map((relative) => normalizeGitPath(relative));
    if (changed.some((relative) => lease.selectors.some((selector) => selectorMatches(selector, relative)))) {
      throw new RoomError("head_conflict", "HEAD changed a path reserved by this lease.");
    }
  }

  private async makeCommitHooks(root: string, temporaryRoot: string, before: GateScan, selectors: string[]): Promise<string> {
    const hookPathResult = await command(root, ["rev-parse", "--git-path", "hooks"]);
    if (hookPathResult.code !== 0) throw new RoomError("git_hooks", hookPathResult.stderr.trim() || "Unable to locate Git hooks.");
    const originalHooks = path.resolve(root, hookPathResult.stdout.trim());
    const temporaryHooks = path.join(temporaryRoot, "hooks");
    fs.mkdirSync(temporaryHooks, { recursive: true, mode: 0o700 });
    for (const hookName of ["pre-commit", "commit-msg"]) {
      const original = path.join(originalHooks, hookName);
      const originalPath = fs.existsSync(original) ? fs.realpathSync.native(original) : undefined;
      const guardPath = path.join(temporaryRoot, `${hookName}-guard.mjs`);
      fs.writeFileSync(guardPath, hookGuardScript(before.head.oid ?? "", before.head.branch ?? "", before.refFingerprint, selectors), { encoding: "utf8", mode: 0o700, flag: "wx" });
      const wrapperPath = path.join(temporaryHooks, hookName);
      fs.writeFileSync(wrapperPath, hookWrapperSource(originalPath, guardPath, true), { encoding: "utf8", mode: 0o700, flag: "wx" });
      try { fs.chmodSync(wrapperPath, 0o700); } catch { /* Windows does not require executable bits. */ }
    }
    return temporaryHooks;
  }

  private markUnexpectedCommitMutation(sessionId: string, before: GateScan, after: GateScan, requested: string[], commitSucceeded: boolean): void {
    if (!commitSucceeded && (after.head.branch !== before.head.branch || after.head.oid !== before.head.oid || after.refFingerprint !== before.refFingerprint)) {
      this.markCompromised("Commit hook or external code changed HEAD or refs unexpectedly.", sessionId);
      throw new RoomError("compromised", "Commit changed HEAD or refs unexpectedly.");
    }
    if (!commitSucceeded && after.indexFingerprint !== before.indexFingerprint) {
      this.markCompromised("Commit hook changed the shared Git index.", sessionId);
      throw new RoomError("compromised", "Commit hook changed the shared Git index.");
    }
    const changed = this.changedPaths(before, after);
    const unexpected = changed.filter((relative) => !pathCoveredByAny(requested, relative));
    if (unexpected.length) {
      this.markCompromised("Commit hook changed paths outside the requested set.", sessionId, unexpected);
      throw new RoomError("compromised", "Commit hook changed paths outside the requested set.", { paths: unexpected });
    }
    if (after.statusPaths.some((relative) => pathCoveredByAny(requested, relative))) {
      this.markCompromised("Commit hook left a requested path dirty.", sessionId, after.statusPaths);
      throw new RoomError("compromised", "Commit hook left a requested path dirty.");
    }
  }

  private async commit(sessionId: string, payload: Record<string, unknown>): Promise<CommitResult> {
    this.ensureHealthy();
    const message = requireString(payload.message, "message", 10_000);
    if (message.includes("\0")) throw new RoomError("invalid_payload", "message is invalid.");
    if (!Array.isArray(payload.paths) || payload.paths.length < 1 || payload.paths.length > MAX_SELECTOR_COUNT) {
      throw new RoomError("invalid_payload", "commit requires 1-64 paths.");
    }
    const requested = [...new Set(payload.paths.map((value) => normalizeSelector(value)))];
    const before = await scanGitState(this.identity.root);
    if (before.refFingerprint !== this.refFingerprint || before.head.branch !== this.state.head.branch || before.head.oid !== this.state.head.oid) {
      this.markCompromised("HEAD or refs changed outside the collaboration coordinator.", sessionId);
      throw new RoomError("compromised", "HEAD or refs changed outside the collaboration coordinator.");
    }
    const selectedLeases = new Set<FileLease>();
    for (const requestedPath of requested) {
      const lease = Object.values(this.state.leases).find((entry) =>
        entry.ownerSessionId === sessionId &&
        (entry.state === "active" || entry.state === "dirty") &&
        entry.epoch === this.state.epoch &&
        entry.selectors.some((selector) => selectorCovers(selector, requestedPath)),
      );
      if (!lease) throw new RoomError("lease_required", `Commit path '${requestedPath}' is not covered by an owned lease.`);
      selectedLeases.add(lease);
    }
    this.validateActiveLeases();
    for (const lease of selectedLeases) {
      if (lease.state !== "active" && lease.state !== "dirty") throw new RoomError("lease_invalid", `Lease '${lease.id}' is '${lease.state}'.`);
      this.validateLease(lease);
      await this.assertHeadConflict(lease, before.head.oid);
    }
    for (const relative of before.statusPaths) {
      const owner = Object.values(this.state.leases).find((lease) =>
        (lease.state === "active" || lease.state === "dirty") && lease.selectors.some((selector) => selectorMatches(selector, relative)),
      );
      if (!owner) throw new RoomError("foreign_change", `Unowned or foreign change exists at '${relative}'.`);
    }
    const sharedStaged = await gitStagedPaths(this.identity.root);
    if (sharedStaged.length) throw new RoomError("foreign_change", `Shared index contains staged paths: ${sharedStaged.join(", ")}.`);

    const temporaryRoot = fs.mkdtempSync(path.join(this.identity.roomDir, "commit-"));
    const indexPath = path.join(temporaryRoot, "index");
    try {
      const tempEnv: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };
      delete tempEnv.GIT_DIR;
      delete tempEnv.GIT_WORK_TREE;
      delete tempEnv.GIT_COMMON_DIR;
      const readTree = await command(this.identity.root, ["read-tree", "HEAD"], 8_000, tempEnv);
      if (readTree.code !== 0) throw new RoomError("git_index", readTree.stderr.trim() || "Unable to create a temporary Git index.");
      const add = await command(this.identity.root, ["add", "-A", "--", ...requested], 8_000, tempEnv);
      if (add.code !== 0) throw new RoomError("git_add", add.stderr.trim() || "Unable to stage the requested paths.");
      const temporaryStaged = await gitStagedPaths(this.identity.root, tempEnv);
      if (!temporaryStaged.length) throw new RoomError("nothing_to_commit", "The requested paths have no changes to commit.");
      if (temporaryStaged.some((relative) => !pathCoveredByAny(requested, relative) || !pathCoveredByAny([...selectedLeases].flatMap((lease) => lease.selectors), relative))) {
        throw new RoomError("foreign_change", "Temporary index contains a path outside the requested leases.");
      }
      const hooksPath = await this.makeCommitHooks(this.identity.root, temporaryRoot, before, requested);
      const hooksConfigPath = hooksPath.replace(/\\/g, "/");
      let commit: CommandResult | undefined;
      let commitError: unknown;
      try {
        commit = await command(this.identity.root, ["-c", `core.hooksPath=${hooksConfigPath}`, "commit", "-m", message, "--", ...requested], 120_000, tempEnv);
      } catch (error) {
        commitError = error;
      }
      if (commitError) {
        const failedAfter = await scanGitState(this.identity.root);
        this.markUnexpectedCommitMutation(sessionId, before, failedAfter, [], false);
        throw new RoomError("commit_failed", commitError instanceof Error ? commitError.message : String(commitError));
      }
      if (!commit) throw new RoomError("commit_failed", "Git did not produce a result.");
      if (commit.code !== 0) {
        const failedAfter = await scanGitState(this.identity.root);
        this.markUnexpectedCommitMutation(sessionId, before, failedAfter, [], false);
        throw new RoomError("commit_failed", commit.stderr.trim() || commit.stdout.trim() || "Git commit failed.");
      }
      const preReset = await scanGitState(this.identity.root);
      if (preReset.indexFingerprint !== before.indexFingerprint) {
        this.markCompromised("A shared staged change appeared during commit.", sessionId, preReset.statusPaths);
        throw new RoomError("compromised", "A shared staged change appeared during commit.");
      }
      const sharedEnv: NodeJS.ProcessEnv = { ...process.env };
      delete sharedEnv.GIT_DIR;
      delete sharedEnv.GIT_WORK_TREE;
      delete sharedEnv.GIT_COMMON_DIR;
      delete sharedEnv.GIT_INDEX_FILE;
      const sync = await command(this.identity.root, ["add", "-A", "--", ...requested], 8_000, sharedEnv);
      if (sync.code !== 0) {
        this.markCompromised("Unable to synchronize the shared index after commit.", sessionId);
        throw new RoomError("compromised", sync.stderr.trim() || "Unable to synchronize the shared index after commit.");
      }
      const stagedAfterSync = await gitStagedPaths(this.identity.root, sharedEnv);
      if (stagedAfterSync.length) {
        this.markCompromised("The shared index remained staged after commit.", sessionId, stagedAfterSync);
        throw new RoomError("compromised", "The shared index remained staged after commit.");
      }
      const after = await scanGitState(this.identity.root);
      this.markUnexpectedCommitMutation(sessionId, before, after, requested, true);
      if (after.head.oid === before.head.oid || !after.head.oid) throw new RoomError("commit_failed", "Git did not produce a new commit.");
      const beforeRefs = refEntries(before.refs);
      const afterRefs = refEntries(after.refs);
      const changedRefs = new Set([...beforeRefs.keys(), ...afterRefs.keys()].filter((ref) => beforeRefs.get(ref) !== afterRefs.get(ref)));
      if (before.head.branch) {
        const branchRef = `refs/heads/${before.head.branch}`;
        if (changedRefs.size !== 1 || !changedRefs.has(branchRef) || afterRefs.get(branchRef) !== after.head.oid) {
          this.markCompromised("Commit changed an unexpected Git ref.", sessionId);
          throw new RoomError("compromised", "Commit changed an unexpected Git ref.");
        }
      } else if (changedRefs.size) {
        this.markCompromised("Detached-head commit changed an unexpected Git ref.", sessionId);
        throw new RoomError("compromised", "Commit changed an unexpected Git ref.");
      }
      for (const lease of selectedLeases) {
        for (const requestedPath of requested) {
          if (!lease.selectors.some((selector) => selectorCovers(selector, requestedPath))) continue;
          const scanned = scanSelector(this.identity.root, selectorBase(requestedPath));
          for (const [relative, fingerprint] of Object.entries(scanned.fingerprints)) {
            lease.baseline[relative] = fingerprint;
            this.updateLeaseObservation(lease, relative, fingerprint);
          }
          if (!requestedPath.endsWith("/**")) {
            const exact = fingerprintAt(this.identity.root, requestedPath);
            lease.baseline[requestedPath] = exact.fingerprint;
            this.updateLeaseObservation(lease, requestedPath, exact.fingerprint);
          }
        }
        this.refreshLeaseState(lease);
      }
      this.state.head = after.head;
      this.refFingerprint = after.refFingerprint;
      this.state.refFingerprint = after.refFingerprint;
      this.touch("commit", sessionId, temporaryStaged);
      return { oid: after.head.oid, paths: temporaryStaged, epoch: this.state.epoch };
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  private validateLease(lease: FileLease): void {
    for (const selector of lease.selectors) {
      const current = scanSelector(this.identity.root, selector);
      for (const [relative, expected] of Object.entries(lease.observed)) {
        if (!selectorMatches(selector, relative)) continue;
        const actual = current.fingerprints[relative] ?? null;
        const identity = current.identities[relative];
        if (actual !== expected || !sameIdentity(lease.identities[relative], identity)) {
          lease.state = "invalid";
          this.touch("lease-invalid", lease.ownerSessionId, [relative]);
          throw new RoomError("foreign_change", `Lease target '${relative}' changed externally.`);
        }
      }
      for (const relative of Object.keys(current.fingerprints)) {
        if (!(relative in lease.observed)) {
          lease.state = "invalid";
          this.touch("lease-invalid", lease.ownerSessionId, [relative]);
          throw new RoomError("foreign_change", `New unowned file '${relative}' appeared under the lease.`);
        }
      }
    }
  }

  private validateActiveLeases(): void {
    for (const lease of Object.values(this.state.leases)) {
      if (!activeLease(lease.state) || lease.state === "orphaned") continue;
      try { this.validateLease(lease); } catch { /* state is already invalid */ }
    }
  }

  private expireCleanLeases(): void {
    const timestamp = Date.now();
    for (const lease of Object.values(this.state.leases)) {
      if (lease.state === "active" && Date.parse(lease.expiresAt) <= timestamp) {
        lease.state = "released";
        this.touch("release", lease.ownerSessionId, lease.selectors);
      }
    }
  }

  private touch(kind: ActivityEntry["kind"], sessionId: string, paths: string[]): void {
    this.state.seq += 1;
    this.state.activity.push({ seq: this.state.seq, kind, sessionId, paths: paths.slice(0, MAX_SELECTOR_COUNT), at: now() });
    this.state.activity = this.state.activity.slice(-this.config.activityLimit);
    this.state.updatedAt = now();
    this.persist();
  }

  private persist(): void {
    if (this.closing) return;
    this.state.updatedAt = now();
    this.state.pendingAsks = [...this.pendingAsks].map(([requestId, ask]) => ({
      requestId,
      fromSessionId: ask.fromSessionId,
      toSessionId: ask.toSessionId,
      expiresAt: new Date(ask.expiresAt).toISOString(),
    }));
    persistJson(this.identity.snapshotPath, this.state);
  }

  private writeLock(): void {
    if (this.lockFd < 0) return;
    const lock: LockRecord = { schema: 1, pid: process.pid, connectionId: this.lockConnectionId, epoch: this.state.epoch, heartbeatAt: now() };
    const encoded = Buffer.from(`${JSON.stringify(lock)}\n`, "utf8");
    fs.ftruncateSync(this.lockFd, 0);
    fs.writeSync(this.lockFd, encoded, 0, encoded.length, 0);
    fs.fsyncSync(this.lockFd);
  }
}

function atomicWrite(root: string, relative: string, content: string, expected: string | null, expectedIdentity?: FileIdentity): void {
  const absolute = assertPathChain(root, relative);
  const before = fingerprintAt(root, relative);
  if (before.fingerprint !== expected || !sameIdentity(expectedIdentity, before.identity)) {
    throw new RoomError("foreign_change", "Target changed before atomic mutation.");
  }
  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, { recursive: true });
  assertPathChain(root, relative);
  const existing = fs.existsSync(absolute) ? fs.lstatSync(absolute) : undefined;
  const temporary = path.join(parent, `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: existing?.mode ?? 0o600, flag: "wx" });
  try {
    if (existing) fs.chmodSync(temporary, existing.mode & 0o777);
    const recheck = fingerprintAt(root, relative);
    if (recheck.fingerprint !== expected || !sameIdentity(expectedIdentity, recheck.identity)) {
      throw new RoomError("foreign_change", "Target changed during atomic mutation.");
    }
    fs.renameSync(temporary, absolute);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export class RoomClient {
  readonly identity: ProjectIdentity;
  readonly sessionId: string;
  readonly connectionId: string;
  private readonly coordinator?: Coordinator;
  private readonly channel?: JsonRpcChannel;
  private readonly config: CollaborationConfig;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private epoch = 0;
  private connected: boolean;
  private reason?: string;

  private constructor(identity: ProjectIdentity, session: RoomSessionInfo, options: { coordinator?: Coordinator; channel?: JsonRpcChannel; reason?: string; config: CollaborationConfig; connectionId?: string }) {
    this.identity = identity;
    this.sessionId = session.sessionId;
    this.connectionId = options.connectionId ?? randomUUID();
    this.coordinator = options.coordinator;
    this.channel = options.channel;
    this.config = options.config;
    this.connected = Boolean(options.coordinator || options.channel);
    this.reason = options.reason;
  }

  static degraded(identity: ProjectIdentity, session: RoomSessionInfo, reason: string, config: CollaborationConfig): RoomClient {
    return new RoomClient(identity, session, { reason, config });
  }

  static async connect(identity: ProjectIdentity, session: RoomSessionInfo, coordinator: Coordinator | undefined, channel: JsonRpcChannel | undefined, config: CollaborationConfig, connectionId?: string): Promise<RoomClient> {
    const client = new RoomClient(identity, session, { coordinator, channel, config, ...(connectionId ? { connectionId } : {}) });
    try {
      const result = await client.request("join", { sessionId: session.sessionId, connectionId: client.connectionId, displayName: session.displayName, pid: session.pid }, true);
      client.epoch = result.epoch;
      client.heartbeatTimer = setInterval(() => { void client.heartbeat(); }, Math.max(500, Math.floor(config.heartbeatMs)));
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get ready(): boolean { return this.connected; }
  get degradedReason(): string | undefined { return this.reason; }

  async snapshot(): Promise<RoomSnapshot> {
    return (await this.request("status", {})).snapshot as RoomSnapshot;
  }

  async claim(payload: Record<string, unknown>): Promise<TaskClaim> {
    return (await this.request("claim", payload)).value as TaskClaim;
  }

  async reserve(paths: string[]): Promise<FileLease> {
    return (await this.request("reserve", { paths })).value as FileLease;
  }

  async release(leaseId: string): Promise<FileLease> {
    return (await this.request("release", { leaseId })).value as FileLease;
  }

  async updatePresence(update: PresenceUpdate): Promise<void> {
    await this.request("heartbeat", update);
  }

  async inbox(): Promise<RoomMessage[]> {
    if (!this.ready) return [];
    return (await this.request("inbox", {})).value as RoomMessage[];
  }

  async send(to: string, message: string): Promise<RoomMessage> {
    return (await this.request("send", { to, message })).value as RoomMessage;
  }

  async ask(to: string, message: string, requestId?: string): Promise<AskResult> {
    return (await this.request("ask", { to, message, ...(requestId ? { requestId } : {}) })).value as AskResult;
  }

  async reply(requestId: string, message: string): Promise<RoomMessage> {
    return (await this.request("reply", { requestId, message })).value as RoomMessage;
  }

  async write(filePath: string, content: string): Promise<unknown> {
    return (await this.request("mutate_write", { path: filePath, content })).value;
  }

  async edit(filePath: string, oldText: string, newText: string): Promise<unknown> {
    return (await this.request("mutate_edit", { path: filePath, oldText, newText })).value;
  }

  async check(checkId: CollaborationCheckId): Promise<CheckResult> {
    if (!this.ready) return this.degradedCheck(checkId);
    return (await this.request("check", { checkId })).value as CheckResult;
  }

  async commit(message: string, paths: string[]): Promise<CommitResult> {
    return (await this.request("commit", { message, paths })).value as CommitResult;
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.connected = false;
    this.channel?.close();
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.connected) {
      try { await this.request("leave", {}, false); } catch { /* coordinator may already be gone */ }
    }
    this.connected = false;
    this.channel?.close();
  }

  private async degradedCheck(checkId: CollaborationCheckId): Promise<CheckResult> {
    if (!(COLLABORATION_CHECK_IDS as readonly string[]).includes(checkId)) throw new RoomError("invalid_check", `Unknown check '${checkId}'.`);
    const check = this.config.checks[checkId];
    const executable = checkExecutable(check);
    const before = await scanGitState(this.identity.root);
    let execution: CommandResult | undefined;
    let executionError: unknown;
    try {
      execution = await runProgram(executable, check.args, this.identity.root, CHECK_TIMEOUT_MS, checkEnvironment());
    } catch (error) {
      executionError = error;
    }
    const after = await scanGitState(this.identity.root);
    if (after.head.branch !== before.head.branch || after.head.oid !== before.head.oid || after.refFingerprint !== before.refFingerprint) {
      throw new RoomError("compromised", "The read-only check changed HEAD or Git refs.");
    }
    if (after.indexFingerprint !== before.indexFingerprint || changedGatePaths(before, after).length) {
      throw new RoomError("foreign_change", "The read-only check changed the Git worktree or index.");
    }
    if (executionError) throw new RoomError("check_failed", executionError instanceof Error ? executionError.message : String(executionError));
    if (!execution) throw new RoomError("check_failed", "Check did not produce a result.");
    return { checkId, code: execution.code, stdout: truncateOutput(execution.stdout), stderr: truncateOutput(execution.stderr) };
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.request("heartbeat", {});
    } catch (error) {
      this.connected = false;
      this.reason = error instanceof Error ? error.message : String(error);
    }
  }

  private async request(method: string, payload: unknown, joining = false): Promise<{ epoch: number; snapshot: RoomSnapshot; value: unknown }> {
    if (!this.connected && !joining) throw new RoomError("room_unavailable", this.reason || "Room coordinator is unavailable.");
    const request: RpcRequest = {
      id: randomUUID(),
      method,
      payload,
      epoch: joining ? 0 : this.epoch,
      sessionId: this.sessionId,
      connectionId: this.connectionId,
    };
    const timeoutMs = method === "check" || method === "commit" ? CHECK_TIMEOUT_MS + 10_000 : 5_000;
    let response: RpcResponse;
    try {
      response = this.coordinator ? await this.coordinator.invoke(request) : await this.channel!.request(request, timeoutMs);
    } catch (error) {
      if (error instanceof RoomError && (error.code === "room_timeout" || error.code === "room_disconnected")) this.connected = false;
      throw error;
    }
    if (!response.ok) {
      const code = response.error?.code;
      if (code === "stale_epoch" || code === "session_not_joined" || code === "room_disconnected") this.connected = false;
      throw new RoomError(code || "room_error", response.error?.message || "Room request failed.", response.error?.details);
    }
    const result = (response.result ?? {}) as { epoch?: unknown; snapshot?: RoomSnapshot; value?: unknown };
    if (typeof result.epoch === "number") this.epoch = result.epoch;
    return { epoch: this.epoch, snapshot: result.snapshot ?? (result as unknown as RoomSnapshot), value: result.value ?? result };
  }
}

export async function connectRoom(
  cwd: string,
  session: RoomSessionInfo,
  env: NodeJS.ProcessEnv = process.env,
  options: { connectionId?: string } = {},
): Promise<RoomClient> {
  const config = readCollaborationConfig(env);
  const identity = await resolveProjectIdentity(cwd, env);
  fs.mkdirSync(identity.roomDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const coordinator = new Coordinator(identity, config.config);
    try {
      await coordinator.start();
      return await RoomClient.connect(identity, session, coordinator, undefined, config.config, options.connectionId);
    } catch (error) {
      await coordinator.close();
      if (!(error instanceof LockHeldError)) throw error;
    }
    if (takeOverStaleLock(identity)) continue;
    try {
      const channel = await JsonRpcChannel.connect(identity.socketPath);
      return await RoomClient.connect(identity, session, undefined, channel, config.config, options.connectionId);
    } catch (error) {
      const lock = readLock(identity);
      if (lock && processIsAlive(lock.pid)) {
        await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
        continue;
      }
      if (!takeOverStaleLock(identity)) return RoomClient.degraded(identity, session, error instanceof Error ? error.message : String(error), config.config);
    }
  }
  return RoomClient.degraded(identity, session, "Coordinator takeover is uncertain; mutations are disabled.", config.config);
}

export function roomDegradedStatus(client: RoomClient): Record<string, unknown> {
  return {
    ready: client.ready,
    degraded: !client.ready,
    projectKey: client.identity.projectKey,
    root: client.identity.root,
    reason: client.degradedReason,
  };
}
