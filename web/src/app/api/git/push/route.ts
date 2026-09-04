import { NextRequest, NextResponse } from "next/server";
import { gitDirectoryError, runGit } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    directory?: unknown;
    remote?: unknown;
    branch?: unknown;
    setUpstream?: unknown;
    force?: unknown;
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
  if (
    (body.remote !== undefined && typeof body.remote !== "string") ||
    (body.branch !== undefined && typeof body.branch !== "string") ||
    (body.setUpstream !== undefined && typeof body.setUpstream !== "boolean") ||
    (body.force !== undefined && typeof body.force !== "boolean")
  ) {
    return NextResponse.json({ error: "invalid push options" }, { status: 400 });
  }
  const remoteRaw = body.remote as string | undefined;
  const branchRaw = body.branch as string | undefined;
  const setUpstream = body.setUpstream === true;
  const force = body.force === true;

  const remote = remoteRaw?.trim() || "origin";
  if (!REMOTE_RE.test(remote)) {
    return NextResponse.json({ error: "invalid remote" }, { status: 400 });
  }

  const args = ["push"];
  if (force) args.push("--force-with-lease");
  if (setUpstream) args.push("-u");

  if (branchRaw?.trim()) {
    const branch = branchRaw.trim();
    if (
      branch.length > 200 ||
      !/^[\p{L}\p{N}._/+-]+$/u.test(branch) ||
      branch.startsWith("-") ||
      branch.startsWith("/") ||
      branch.endsWith("/") ||
      branch.includes("..") ||
      branch.includes("//") ||
      branch.includes(":")
    ) {
      return NextResponse.json({ error: "invalid branch" }, { status: 400 });
    }
    args.push(remote, branch);
  } else {
    args.push(remote, "HEAD");
  }

  const result = await runGit(body.directory, args);
  if (result.code !== 0) {
    return NextResponse.json(
      {
        error: result.stderr.trim() || result.stdout.trim() || "git push failed",
      },
      { status: 500 },
    );
  }

  const summary =
    /^\*\s+(.+)$/m.exec(result.stdout)?.[1]?.trim() ||
    result.stdout.trim() ||
    "pushed";

  return NextResponse.json({ ok: true, summary });
}
