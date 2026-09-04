import { NextRequest, NextResponse } from "next/server";
import { gitDirectoryError, runGit } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/**
 * Initialize a git repository in the project directory.
 *
 * `git init` is idempotent — re-running on an existing repository succeeds
 * ("Reinitialized existing Git repository"), so no pre-check is needed.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    directory?: unknown;
  } | null;
  const directory = body?.directory;

  if (typeof directory !== "string" || !directory) {
    return errorResponse("directory is required", 400);
  }
  const directoryError = gitDirectoryError(directory);
  if (directoryError) {
    return errorResponse(
      directoryError,
      directoryError === "directory is not allowed" ? 403 : 400,
    );
  }
  const init = await runGit(directory, ["init"]);
  if (init.code !== 0) {
    return errorResponse(init.stderr.trim() || "git init failed", 500);
  }

  return NextResponse.json({ ok: true, directory });
}
