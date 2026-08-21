import { NextRequest, NextResponse } from "next/server";
import { gitBranchRefs, gitLogGraph } from "@/lib/git";
import { isAbsolutePath } from "@/lib/paths";
import type { GraphLogPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const directory = req.nextUrl.searchParams.get("directory");
  if (!directory || !isAbsolutePath(directory)) {
    return NextResponse.json({ error: "directory is required" }, { status: 400 });
  }

  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "80");
  const skip = Number(req.nextUrl.searchParams.get("skip") ?? "0");

  try {
    const [{ commits, hasMore }, { refs, currentBranch }] = await Promise.all([
      gitLogGraph(directory, Number.isFinite(limit) ? limit : 80, Number.isFinite(skip) ? skip : 0),
      gitBranchRefs(directory),
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
