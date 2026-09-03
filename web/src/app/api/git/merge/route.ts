import { NextRequest, NextResponse } from "next/server";
import { assertSafeBranchName, gitDirectoryError, runGit } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Local merge of current HEAD into target branch (default: main/master),
 * or merge target into current — controlled by `into`.
 *
 * into=current (default): git merge <branch>  (bring branch into current)
 * into=branch: checkout target, merge current tip, then return to current
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    directory?: string;
    branch?: string;
    into?: "current" | "branch";
    noFf?: boolean;
    message?: string;
  } | null;

  if (!body?.directory || !body.branch?.trim()) {
    return NextResponse.json(
      { error: "directory and branch are required" },
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

  try {
    assertSafeBranchName(body.branch.trim());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid branch" },
      { status: 400 },
    );
  }

  const branch = body.branch.trim();
  const into = body.into ?? "current";

  const head = await runGit(body.directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.code !== 0) {
    return NextResponse.json(
      { error: head.stderr.trim() || "cannot read HEAD" },
      { status: 500 },
    );
  }
  const currentBranch = head.stdout.trim();

  if (into === "branch") {
    const co = await runGit(body.directory, ["checkout", branch]);
    if (co.code !== 0) {
      const stderr = co.stderr.trim();
      const inUseElsewhere = /already checked out|already used by worktree/i.test(stderr);
      return NextResponse.json(
        {
          error: inUseElsewhere
            ? `対象ブランチ「${branch}」は別の作業ツリーでチェックアウト中のため反映できません。`
            : stderr || `checkout ${branch} failed`,
          worktreeConflict: inUseElsewhere || undefined,
        },
        { status: inUseElsewhere ? 409 : 500 },
      );
    }
    const args = ["merge"];
    if (body.noFf) args.push("--no-ff");
    if (body.message?.trim()) args.push("-m", body.message.trim());
    args.push(currentBranch);
    const merge = await runGit(body.directory, args);
    if (merge.code !== 0) {
      await runGit(body.directory, ["merge", "--abort"]).catch(() => undefined);
      const back = await runGit(body.directory, ["checkout", currentBranch]);
      if (back.code !== 0) {
        return NextResponse.json(
          {
            error:
              (merge.stderr.trim() || merge.stdout.trim() || "merge failed") +
              `（元ブランチ「${currentBranch}」への復帰にも失敗）`,
            conflict: /CONFLICT/i.test(merge.stdout + merge.stderr),
            strandedOn: branch,
            restored: null,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          error: merge.stderr.trim() || merge.stdout.trim() || "merge failed",
          conflict: /CONFLICT/i.test(merge.stdout + merge.stderr),
        },
        { status: 409 },
      );
    }
    const restore = await runGit(body.directory, ["checkout", currentBranch]);
    if (restore.code !== 0) {
      return NextResponse.json(
        {
          error: `マージは成功しましたが元ブランチ「${currentBranch}」へ戻れませんでした: ${restore.stderr.trim() || "checkout failed"}`,
          mergeSucceeded: true,
          merged: currentBranch,
          into: branch,
          summary: merge.stdout.trim(),
          restored: null,
          strandedOn: branch,
        },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      merged: currentBranch,
      into: branch,
      summary: merge.stdout.trim(),
      restored: currentBranch,
    });
  }

  const args = ["merge"];
  if (body.noFf) args.push("--no-ff");
  if (body.message?.trim()) args.push("-m", body.message.trim());
  args.push(branch);
  const merge = await runGit(body.directory, args);
  if (merge.code !== 0) {
    await runGit(body.directory, ["merge", "--abort"]).catch(() => undefined);
    return NextResponse.json(
      {
        error: merge.stderr.trim() || merge.stdout.trim() || "merge failed",
        conflict: /CONFLICT/i.test(merge.stdout + merge.stderr),
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    merged: branch,
    into: currentBranch,
    summary: merge.stdout.trim(),
  });
}
