import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { commitPathError, gitDirectoryError, runGit } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isUnder(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/**
 * Delete a changed file from the working tree (and the index for tracked
 * files). Tracked files go through `git rm -f` so the staged deletion is
 * ready for the next commit; untracked files are unlinked directly.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    directory?: unknown;
    path?: string;
  } | null;
  const directory = body?.directory;

  if (typeof directory !== "string" || !directory || !body.path) {
    return errorResponse("directory and path are required", 400);
  }
  const directoryError = gitDirectoryError(directory);
  if (directoryError) {
    return errorResponse(
      directoryError,
      directoryError === "directory is not allowed" ? 403 : 400,
    );
  }
  const pathErr = commitPathError(body.path);
  if (pathErr) {
    return errorResponse(pathErr, 400);
  }

  const abs = path.resolve(directory, body.path);
  if (!isUnder(directory, abs)) {
    return errorResponse("file path is outside the project", 403);
  }
  if (!fs.existsSync(abs)) {
    return errorResponse("file was not found", 404);
  }

  const tracked = await runGit(directory, [
    "ls-files",
    "--error-unmatch",
    "--",
    body.path,
  ]);
  if (tracked.code === 0) {
    const rm = await runGit(directory, ["rm", "-f", "--", body.path]);
    if (rm.code !== 0) {
      return errorResponse(rm.stderr.trim() || "git rm failed", 500);
    }
  } else {
    try {
      fs.rmSync(abs, { force: true });
    } catch (err) {
      return errorResponse(
        `削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
  }

  return NextResponse.json({ ok: true, path: body.path });
}
