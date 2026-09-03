import { NextRequest, NextResponse } from "next/server";
import { gitBranchRefs, gitDirectoryError, gitLogGraph } from "@/lib/git";
import type { GraphLogPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "80");
  const skip = Number(req.nextUrl.searchParams.get("skip") ?? "0");

  try {
    const [{ commits, hasMore }, { refs, currentBranch }] = await Promise.all([
      gitLogGraph(dir, Number.isFinite(limit) ? limit : 80, Number.isFinite(skip) ? skip : 0),
      gitBranchRefs(dir),
    ]);
    const payload: GraphLogPayload = {
      commits,
      refs,
      currentBranch,
      hasMore,
    };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "git log failed",
        commits: [],
        refs: [],
        currentBranch: null,
        hasMore: false,
      },
      { status: 400 },
    );
  }
}
