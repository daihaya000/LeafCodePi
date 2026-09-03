import { NextRequest, NextResponse } from "next/server";
import { gitCommitFileDiff, gitCommitFiles, gitDirectoryError } from "@/lib/git";
import type { GraphShowPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const directory = req.nextUrl.searchParams.get("directory");
  const commit = req.nextUrl.searchParams.get("commit");
  const file = req.nextUrl.searchParams.get("file");
  const directoryError = gitDirectoryError(directory);
  if (directoryError) {
    return NextResponse.json(
      { error: directoryError },
      { status: directoryError === "directory is not allowed" ? 403 : 400 },
    );
  }
  if (!commit) {
    return NextResponse.json({ error: "commit is required" }, { status: 400 });
  }

  try {
    if (file) {
      const diff = await gitCommitFileDiff(directory!, commit, file);
      const payload: GraphShowPayload = { commit, diff };
      return NextResponse.json(payload);
    }
    const files = await gitCommitFiles(directory!, commit);
    const payload: GraphShowPayload = { commit, files };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "git show failed" },
      { status: 400 },
    );
  }
}
