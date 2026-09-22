import { NextRequest, NextResponse } from "next/server";
import { gitDirectoryError, runGit } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    directory?: unknown;
  } | null;

  if (!body || typeof body.directory !== "string") {
    return NextResponse.json({ error: "directory is required" }, { status: 400 });
  }
  const directoryError = gitDirectoryError(body.directory);
  if (directoryError) {
    return NextResponse.json(
      { error: directoryError },
      { status: directoryError === "directory is not allowed" ? 403 : 400 },
    );
  }

  const result = await runGit(body.directory, ["pull", "--no-edit"]);
  if (result.code !== 0) {
    const error = result.stderr.trim() || result.stdout.trim() || "git pull failed";
    return NextResponse.json(
      { error },
      { status: /CONFLICT|would be overwritten|cannot pull/i.test(error) ? 409 : 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    summary: result.stdout.trim() || "pulled",
  });
}
