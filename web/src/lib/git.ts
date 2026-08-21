import { spawn } from "node:child_process";
import type { GraphCommit, GraphFileChange, GraphRef } from "@/lib/types";

/** Hard ceiling so a hung git process cannot pin a BFF worker forever. */
export const GIT_TIMEOUT_MS = 30_000;

/** Run git with argv array only (no shell). */
export function runGit(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // `core.quotepath=false` keeps non-ASCII paths (e.g. Japanese filenames)
    // literal instead of octal-escaped, so status/diff/name-status output can be
    // matched against the filesystem. The env vars stop git from blocking on an
    // interactive credential/editor prompt, which would hang the HTTP request.
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        ...(env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // If git ever blocks despite the prompt-disabling env vars, kill it and
    // reject so the awaiting HTTP handler fails fast instead of hanging.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (process.platform === "win32" && child.pid) {
          // `child.kill()` only signals the `git` process itself; a
          // credential helper or ssh subprocess it spawned survives and can
          // keep files locked. `taskkill /T` kills the whole process tree.
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => undefined);
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
      reject(new Error(`git timed out after ${timeoutMs}ms: git ${args.join(" ")}`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const SAFE_HASH = /^[0-9a-f]{7,64}$/i;

export function assertSafeCommitHash(hash: string): void {
  if (!SAFE_HASH.test(hash)) throw new Error("invalid commit hash");
}

/**
 * Reject option injection / path traversal / shell-dangerous chars while
 * allowing Unicode branch names (e.g. 機能/ログイン).
 */
const SAFE_BRANCH = /^[\p{L}\p{N}._/+-]+$/u;

export function assertSafeBranchName(name: string): void {
  if (
    !name ||
    name.length > 200 ||
    !SAFE_BRANCH.test(name) ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("..") ||
    name.includes("//")
  ) {
    throw new Error("invalid branch name");
  }
}

/** Reject pathspecs that are magic/glob forms or escape the repo root. */
export function commitPathError(p: string): string | null {
  if (!p || typeof p !== "string") return "empty path";
  if (p.includes("\0")) return `unsafe path: ${p}`;
  if (p.includes("..") || p.startsWith("-")) return `unsafe path: ${p}`;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p)) {
    return `unsafe path: ${p}`;
  }
  if (p.startsWith(":")) return `unsafe path: ${p}`;
  if (p === "." || p === "*" || p === "**" || p.includes("*") || p.includes("?")) {
    return `unsafe path: ${p}`;
  }
  return null;
}

/** Unstaged + staged unified diff (no pager). */
export async function gitDiff(cwd: string): Promise<string> {
  const staged = await runGit(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "-M"]);
  const unstaged = await runGit(cwd, ["diff", "--no-color", "--no-ext-diff", "-M"]);
  if (staged.code !== 0 && unstaged.code !== 0) {
    throw new Error(
      staged.stderr.trim() || unstaged.stderr.trim() || "git diff failed",
    );
  }
  const parts = [staged.stdout.trim(), unstaged.stdout.trim()].filter(Boolean);
  return parts.join("\n\n") || "";
}

const LOG_SEP = "\x1f";
const LOG_REC = "\x1e";

/** Commits for graph panel (newest first). */
export async function gitLogGraph(
  cwd: string,
  limit = 80,
  skip = 0,
): Promise<{ commits: GraphCommit[]; hasMore: boolean }> {
  const n = Math.min(Math.max(limit, 1), 200);
  const s = Math.max(skip, 0);
  const fmt = ["%H", "%P", "%s", "%an", "%ae", "%cI"].join(LOG_SEP);
  const result = await runGit(cwd, [
    "log",
    "--all",
    "--date-order",
    `-n${n + 1}`,
    `--skip=${s}`,
    `--pretty=format:${fmt}${LOG_REC}`,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git log failed");
  }
  const raw = result.stdout.split(LOG_REC).map((r) => r.trim()).filter(Boolean);
  const hasMore = raw.length > n;
  const commits = raw.slice(0, n).map((rec) => {
    const [hash, parents, subject, author, authorEmail, date] = rec.split(LOG_SEP);
    return {
      hash: hash ?? "",
      shortHash: (hash ?? "").slice(0, 7),
      parents: (parents ?? "").trim() ? (parents ?? "").trim().split(/\s+/) : [],
      subject: subject ?? "",
      author: author ?? "",
      authorEmail: authorEmail ?? "",
      date: date ?? "",
    };
  });
  return { commits, hasMore };
}

/** Local branch tips (+ current HEAD name). */
export async function gitBranchRefs(
  cwd: string,
): Promise<{ refs: GraphRef[]; currentBranch: string | null }> {
  const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = head.code === 0 ? head.stdout.trim() : null;

  const listed = await runGit(cwd, [
    "for-each-ref",
    "--format=%(objectname)%00%(refname:short)",
    "refs/heads",
  ]);
  if (listed.code !== 0) {
    return { refs: [], currentBranch };
  }
  const refs: GraphRef[] = [];
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [hash, name] = line.split("\0");
    if (!hash || !name) continue;
    refs.push({
      name,
      hash,
      current: name === currentBranch,
    });
  }
  return { refs, currentBranch };
}

/** Files changed in a commit (name-status). */
export async function gitCommitFiles(
  cwd: string,
  hash: string,
): Promise<GraphFileChange[]> {
  assertSafeCommitHash(hash);
  const result = await runGit(cwd, [
    "show",
    "--name-status",
    "--format=",
    "--no-renames",
    hash,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git show failed");
  }
  const files: GraphFileChange[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([MADCRTUX])\t(.+)$/.exec(line);
    if (!m) continue;
    files.push({
      status: m[1] as GraphFileChange["status"],
      path: m[2].replace(/\\/g, "/"),
    });
  }
  return files;
}

/** Unified diff for one file in a commit. */
export async function gitCommitFileDiff(
  cwd: string,
  hash: string,
  filePath: string,
): Promise<string> {
  assertSafeCommitHash(hash);
  const normalized = filePath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized.startsWith("-") ||
    normalized.startsWith(":") ||
    normalized.includes("*") ||
    normalized.includes("?")
  ) {
    throw new Error("invalid file path");
  }
  const result = await runGit(cwd, [
    "show",
    "--format=",
    "--no-color",
    "--no-ext-diff",
    hash,
    "--",
    normalized,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git show file failed");
  }
  return result.stdout;
}
