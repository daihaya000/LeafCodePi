import { NextRequest, NextResponse } from "next/server";
import { gitCommitFileDiff, gitCommitFiles } from "@/lib/git";
import { isAbsolutePath } from "@/lib/paths";
import type { GraphShowPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const directory = req.nextUrl.searchParams.get("directory");
  const commit = req.nextUrl.searchParams.get("commit");
  const file = req.nextUrl.searchParams.get("file");
  if (!directory || !isAbsolutePath(directory)) {
    return NextResponse.json({ error: "directory is required" }, { status: 400 });
  }
  if (!commit) {
    return NextResponse.json({ error: "commit is required" }, { status: 400 });
  }

  try {
    if (file) {
      const diff = await gitCommitFileDiff(directory, commit, file);
      const payload: GraphShowPayload = { commit, diff };
      return NextResponse.json(payload);
    }
    const files = await gitCommitFiles(directory, commit);
    const payload: GraphShowPayload = { commit, files };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "git show failed" },
      { status: 400 },
    );
  }
}
