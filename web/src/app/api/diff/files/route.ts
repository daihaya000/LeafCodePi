import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { parseUnifiedDiff, untrackedHunk } from "@/lib/diffparse";
import { gitDirectoryError, runGit } from "@/lib/git";
import type { DiffFile, DiffFilesPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UNTRACKED_BYTES = 200_000;

function normalizeWindowsNamespace(value: string): string {
  if (value.slice(0, 8).toLowerCase() === "\\\\?\\unc\\") {
    return `\\\\${value.slice(8)}`;
  }
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function isUnder(parent: string, child: string): boolean {
  const relative = path.relative(
    normalizeWindowsNamespace(parent),
    normalizeWindowsNamespace(child),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isProbablyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function emptyPayload(
  partial: Partial<DiffFilesPayload> & { error?: string },
): DiffFilesPayload {
  return {
    git: false,
    branch: null,
    files: [],
    additions: 0,
    deletions: 0,
    ...partial,
  };
}

export async function GET(req: NextRequest) {
  const directory = req.nextUrl.searchParams.get("directory");
  const directoryError = gitDirectoryError(directory);
  if (directoryError) {
    return NextResponse.json(
      { error: directoryError },
      { status: directoryError === "directory is not allowed" ? 403 : 400 },
    );
  }
  const dir = directory!;
  const countOnly = req.nextUrl.searchParams.get("count") === "1";

  try {
    if (!fs.existsSync(dir)) {
      return NextResponse.json(
        emptyPayload({ error: `directory does not exist: ${dir}` }),
      );
    }

    // status also validates repositories without a first commit (HEAD is unborn).
    const status = await runGit(dir, ["status", "--porcelain", "-uall"]);
    if (status.code !== 0) {
      return NextResponse.json(emptyPayload({ error: status.stderr.trim() || "git status failed" }));
    }
    const head = await runGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = head.code === 0 ? head.stdout.trim() || null : "HEAD";

    // 件数ポーリングでは diff パース・untracked ファイル読み込みを省略する。
    if (countOnly) {
      const count = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
      return NextResponse.json({
        git: true,
        branch,
        count,
        files: [],
        additions: 0,
        deletions: 0,
      });
    }

    // Clean worktrees need no expensive diff.
    const hasTrackedChanges = status.stdout.split(/\r?\n/).some((line) => line && !line.startsWith("??"));
    const files: DiffFile[] = [];
    if (hasTrackedChanges) {
      // Tracked changes (staged + unstaged vs HEAD); fresh repos fall back.
      let diff = await runGit(dir, [
        "diff",
        "HEAD",
        "--no-color",
        "--no-ext-diff",
        "-M",
      ]);
      if (diff.code !== 0) {
        const unstaged = await runGit(dir, [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "-M",
        ]);
        const staged = await runGit(dir, [
          "diff",
          "--cached",
          "--no-color",
          "--no-ext-diff",
          "-M",
        ]);
        diff = {
          code: 0,
          stdout: [staged.stdout, unstaged.stdout].filter(Boolean).join("\n"),
          stderr: "",
        };
      }
      files.push(...parseUnifiedDiff(diff.stdout));
    }

    for (const line of status.stdout.split(/\r?\n/)) {
      if (!line.startsWith("??")) continue;
      let rel = line.slice(3).trim();
      if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
      const norm = rel.replace(/\\/g, "/");
      if (files.some((f) => f.path === norm)) continue;
      if (rel.endsWith("/")) {
        files.push({
          path: norm,
          additions: 0,
          deletions: 0,
          binary: false,
          untracked: true,
          hunks: [],
        });
        continue;
      }
      const abs = path.resolve(dir, rel);
      const entry: DiffFile = {
        path: norm,
        additions: 0,
        deletions: 0,
        binary: false,
        untracked: true,
        hunks: [],
      };
      // Lexical escape (e.g. ?? ../outside) — list path only, never read.
      if (!isUnder(dir, abs)) {
        files.push(entry);
        continue;
      }
      try {
        const lst = fs.lstatSync(abs);
        if (lst.isSymbolicLink() || lst.isDirectory()) {
          files.push(entry);
          continue;
        }
        const workspace = fs.realpathSync.native(dir);
        const real = fs.realpathSync.native(abs);
        if (!isUnder(workspace, real)) {
          files.push(entry);
          continue;
        }
        if (lst.size <= MAX_UNTRACKED_BYTES) {
          const buf = fs.readFileSync(real);
          if (isProbablyBinary(buf)) {
            entry.binary = true;
          } else {
            const hunk = untrackedHunk(buf.toString("utf8"));
            entry.hunks = [hunk];
            entry.additions = hunk.lines.filter((l) => l.t === "+").length;
          }
        }
      } catch {
        /* unreadable — list path only */
      }
      files.push(entry);
    }

    const additions = files.reduce((n, f) => n + f.additions, 0);
    const deletions = files.reduce((n, f) => n + f.deletions, 0);
    // Last on-disk modification time per file. Deleted/unreadable files stay
    // undefined. The lexical isUnder guard keeps the stat inside the workspace.
    for (const f of files) {
      if (f.modifiedAt) continue;
      const abs = path.resolve(dir, f.path);
      if (!isUnder(dir, abs)) continue;
      try {
        f.modifiedAt = fs.statSync(abs).mtime.toISOString();
      } catch {
        /* deleted or unreadable */
      }
    }
    const payload: DiffFilesPayload = {
      git: true,
      branch,
      files,
      additions,
      deletions,
    };
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(emptyPayload({ error: message }), { status: 200 });
  }
}
