import { NextRequest, NextResponse } from "next/server";
import { runGit } from "@/lib/git";
import { isAbsolutePath } from "@/lib/paths";

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
    directory?: string;
  } | null;

  if (!body?.directory || !isAbsolutePath(body.directory)) {
    return errorResponse("directory is required", 400);
  }

  const init = await runGit(body.directory, ["init"]);
  if (init.code !== 0) {
    return errorResponse(init.stderr.trim() || "git init failed", 500);
  }

  return NextResponse.json({ ok: true, directory: body.directory });
}
