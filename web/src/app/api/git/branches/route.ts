import { NextRequest, NextResponse } from "next/server";
import { runGit } from "@/lib/git";
import { isAbsolutePath } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const directory = req.nextUrl.searchParams.get("directory");
  if (!directory || !isAbsolutePath(directory)) {
    return NextResponse.json({ error: "directory is required" }, { status: 400 });
  }

  const head = await runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branches = await runGit(directory, ["branch", "--format=%(refname:short)"]);
  const upstream = await runGit(directory, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  const aheadCount = await runGit(directory, ["rev-list", "--count", "@{u}..HEAD"]);

  if (head.code !== 0) {
    return NextResponse.json(
      { error: head.stderr.trim() || "not a git repo" },
      { status: 400 },
    );
  }

  const list = branches.stdout
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const current = head.stdout.trim();
  const upstreamBranch = upstream.code === 0 ? upstream.stdout.trim() : null;
  const ahead =
    aheadCount.code === 0 ? parseInt(aheadCount.stdout.trim(), 10) || 0 : -1;

  const remotesResult = await runGit(directory, ["remote"]);
  const remotes =
    remotesResult.code === 0
      ? remotesResult.stdout
          .split(/\r?\n/)
          .map((r) => r.trim())
          .filter(Boolean)
      : [];

  const preferred =
    (upstreamBranch && list.includes(upstreamBranch) ? upstreamBranch : null) ||
    list.find((b) => b === "main") ||
    list.find((b) => b === "master") ||
    list.find((b) => b !== current) ||
    null;

  const defaultTarget = preferred && preferred !== current ? preferred : null;

  return NextResponse.json({
    current,
    branches: list,
    defaultTarget,
    upstream: upstreamBranch,
    ahead,
    remotes,
    hasRemote: remotes.length > 0,
  });
}
