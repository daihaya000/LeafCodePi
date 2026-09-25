import { dirname, resolve } from "node:path";
import { NextResponse } from "next/server";
import { runGit } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function latestAvailableCommit(repoRoot: string, localCommit: string): Promise<string> {
  try {
    const upstream = await runGit(
      repoRoot,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      2_000,
    );
    if (upstream.code !== 0) return localCommit;

    const upstreamName = upstream.stdout.trim();
    const separator = upstreamName.indexOf("/");
    if (separator <= 0 || separator === upstreamName.length - 1) return localCommit;

    const remoteName = upstreamName.slice(0, separator);
    const branchName = upstreamName.slice(separator + 1);
    const remoteRef = `refs/heads/${branchName}`;
    const remote = await runGit(repoRoot, ["ls-remote", "--heads", remoteName, remoteRef], 5_000);
    const remoteCommit = remote.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find(([, ref]) => ref === remoteRef)?.[0];
    if (
      remote.code !== 0 ||
      !remoteCommit ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(remoteCommit) ||
      remoteCommit === localCommit
    ) return localCommit;

    // A remote ancestor means local HEAD is already newer than upstream.
    const remoteIsBehind = await runGit(
      repoRoot,
      ["merge-base", "--is-ancestor", remoteCommit, localCommit],
      2_000,
    );
    return remoteIsBehind.code === 0 ? localCommit : remoteCommit;
  } catch {
    return localCommit;
  }
}

export async function GET() {
  const skillsDir = process.env.LEAFCODE_PI_SKILLS_DIR?.trim()
    ? resolve(process.env.LEAFCODE_PI_SKILLS_DIR)
    : resolve(process.cwd(), "..", "skills");

  try {
    const repoRoot = dirname(skillsDir);
    const result = await runGit(repoRoot, ["log", "-1", "--format=%H%n%cI"], 2_000);
    const [commit, committedAt] = result.stdout.trim().split(/\r?\n/);
    if (result.code !== 0 || !commit || !committedAt) {
      return NextResponse.json({ commit: null, committedAt: null, latestCommit: null }, { status: 503 });
    }
    const latestCommit = await latestAvailableCommit(repoRoot, commit);
    return NextResponse.json({ commit, committedAt, latestCommit });
  } catch {
    return NextResponse.json({ commit: null, committedAt: null, latestCommit: null }, { status: 503 });
  }
}
