import { spawnSync } from "node:child_process";
import { IgnoreRules } from "./ignore.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runGit(root: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export function gitInfo(root: string): GitInfo {
  const check = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
  // Pathspec confines the result to the workspace subtree even when the
  // workspace root sits inside a larger repository.
  const status = runGit(root, ["status", "--porcelain", "--", "."]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : false,
  };
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
}

export function gitStatus(root: string): GitStatusResult {
  const empty: GitStatusResult = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const result = runGit(root, ["status", "--porcelain=v2", "--branch", "--", "."]);
  if (!result.ok) return empty;
  const rules = new IgnoreRules(root);
  const isAllowedPath = (value: string): boolean => {
    const normalized = value.trim().replace(/^"(.*)"$/, "$1").replace(/\\/g, "/");
    return normalized.split(" -> ").every((part) => !rules.isSensitive(part));
  };
  const out: GitStatusResult = { ...empty, isRepo: true };
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      out.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        out.ahead = parseInt(m[1], 10);
        out.behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const filePath = line.startsWith("2 ")
        ? line.split("\t")[0]?.split(" ").slice(9).join(" ") + " -> " + (line.split("\t")[1] ?? "")
        : parts.slice(8).join(" ");
      const x = xy[0];
      const y = xy[1];
      if (!isAllowedPath(filePath)) continue;
      if (x !== ".") out.staged.push({ path: filePath, change: x });
      if (y !== ".") out.unstaged.push({ path: filePath, change: y });
    } else if (line.startsWith("? ")) {
      const filePath = line.slice(2);
      if (isAllowedPath(filePath)) out.untracked.push(filePath);
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const filePath = parts.slice(10).join(" ");
      if (isAllowedPath(filePath)) out.conflicted.push(filePath);
    }
  }
  return out;
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
}

function emptyDiff(mode: DiffMode, offset: number, isRepo: boolean): GitDiffResult {
  return {
    isRepo,
    mode,
    totalBytes: 0,
    offset,
    returnedBytes: 0,
    hasMore: false,
    nextOffset: null,
    diff: "",
  };
}

function gitDiffBase(mode: DiffMode): string[] {
  const base = ["diff", "--no-color"];
  if (mode === "staged") base.push("--cached");
  if (mode === "head") base.push("HEAD");
  return base;
}

export function gitDiff(root: string, opts: GitDiffOptions = {}, relPath?: string): GitDiffResult {
  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const rules = new IgnoreRules(root);
  const base = gitDiffBase(mode);
  let result: GitCommandResult;

  if (relPath) {
    if (rules.isSensitive(relPath)) return emptyDiff(mode, offset, true);
    result = runGit(root, [...base, "--", relPath]);
  } else {
    const names = runGit(root, [...base, "--name-only", "-z", "--", "."]);
    if (!names.ok && /not a git repository/i.test(names.stderr)) return emptyDiff(mode, offset, false);
    if (!names.ok) return emptyDiff(mode, offset, false);
    const allowed = names.stdout
      .split(String.fromCharCode(0))
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && !rules.isSensitive(value));
    if (allowed.length === 0) return emptyDiff(mode, offset, true);
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let chunkBytes = 0;
    const maxPathspecBytes = process.platform === "win32" ? 8 * 1024 : 32 * 1024;
    for (const value of allowed) {
      const valueBytes = Buffer.byteLength(value, "utf8") + 1;
      if (chunk.length > 0 && chunkBytes + valueBytes > maxPathspecBytes) {
        chunks.push(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(value);
      chunkBytes += valueBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);

    const outputs: string[] = [];
    for (const paths of chunks) {
      const part = runGit(root, [...base, "--", ...paths]);
      if (!part.ok) return emptyDiff(mode, offset, true);
      outputs.push(part.stdout);
    }
    result = { ok: true, stdout: outputs.join(""), stderr: "", code: 0 };
  }

  if (!result.ok && /not a git repository/i.test(result.stderr)) return emptyDiff(mode, offset, false);
  if (!result.ok) return emptyDiff(mode, offset, true);

  const full = Buffer.from(result.stdout, "utf8");
  const slice = full.subarray(offset, offset + maxBytes);
  let text = slice.toString("utf8");
  let sliceLen = slice.length;
  // Avoid cutting mid-line when more content follows.
  if (offset + sliceLen < full.length) {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline > 0) {
      text = text.slice(0, lastNewline + 1);
      sliceLen = Buffer.byteLength(text, "utf8");
    }
  }
  const hasMore = offset + sliceLen < full.length;
  return {
    isRepo: true,
    mode,
    totalBytes: full.length,
    offset,
    returnedBytes: sliceLen,
    hasMore,
    nextOffset: hasMore ? offset + sliceLen : null,
    diff: text,
  };
}
