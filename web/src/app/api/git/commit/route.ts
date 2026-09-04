import { NextRequest, NextResponse } from "next/server";
import { commitPathError, gitDirectoryError, runGit } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_MSG = /^[\s\S]{1,2000}$/;
const SAFE_AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    directory?: string;
    message?: unknown;
    paths?: unknown;
    all?: boolean;
    agent?: unknown;
  } | null;

  const agent = body?.agent;
  if (agent !== undefined && typeof agent !== "string") {
    return NextResponse.json({ error: "invalid agent" }, { status: 400 });
  }
  const paths = body?.paths;
  if (
    paths !== undefined &&
    (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
  ) {
    return NextResponse.json({ error: "paths must be an array of strings" }, { status: 400 });
  }
  const validPaths = Array.isArray(paths) ? paths as string[] : undefined;
  const message = body?.message;
  if (!body?.directory || typeof message !== "string" || !message.trim()) {
    return NextResponse.json(
      { error: "directory and message are required" },
      { status: 400 },
    );
  }
  const directoryError = gitDirectoryError(body.directory);
  if (directoryError) {
    return NextResponse.json(
      { error: directoryError },
      { status: directoryError === "directory is not allowed" ? 403 : 400 },
    );
  }
  if (!SAFE_MSG.test(message)) {
    return NextResponse.json({ error: "invalid commit message" }, { status: 400 });
  }

  // Stage — require an explicit all:true or a non-empty paths list.
  if (body.all === true) {
    const add = await runGit(body.directory, ["add", "-A", "--", "."]);
    if (add.code !== 0) {
      return NextResponse.json(
        { error: add.stderr.trim() || "git add failed" },
        { status: 500 },
      );
    }
  } else if (validPaths?.length) {
    for (const p of validPaths) {
      const err = commitPathError(p);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }
    const add = await runGit(body.directory, ["add", "--", ...validPaths]);
    if (add.code !== 0) {
      return NextResponse.json(
        { error: add.stderr.trim() || "git add failed" },
        { status: 500 },
      );
    }
  } else {
    return NextResponse.json(
      { error: "paths or all:true is required" },
      { status: 400 },
    );
  }

  const commitArgs = ["commit", "-m", message.trim()];
  if (!body.all && validPaths?.length) {
    commitArgs.push("--", ...validPaths);
  }

  const agentName = (typeof agent === "string" ? agent.trim() : "") || "build";
  const gitEnv: Record<string, string> | undefined = SAFE_AGENT.test(agentName)
    ? {
        GIT_AUTHOR_NAME: agentName,
        GIT_AUTHOR_EMAIL: `${agentName}@opencode.local`,
        GIT_COMMITTER_NAME: agentName,
        GIT_COMMITTER_EMAIL: `${agentName}@opencode.local`,
      }
    : undefined;

  const commit = await runGit(body.directory, commitArgs, undefined, gitEnv);
  if (commit.code !== 0) {
    return NextResponse.json(
      {
        error: commit.stderr.trim() || commit.stdout.trim() || "git commit failed",
        stdout: commit.stdout,
      },
      { status: 500 },
    );
  }

  const log = await runGit(body.directory, ["log", "-1", "--oneline"]);
  return NextResponse.json({
    ok: true,
    summary: log.stdout.trim() || commit.stdout.trim(),
  });
}
