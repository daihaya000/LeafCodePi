import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { assertSafeBranchName, runGit } from "@/lib/git";
import { isAbsolutePath } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GH_TIMEOUT_MS = 60_000;

function runGh(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(new Error(`gh timed out after ${GH_TIMEOUT_MS}ms`));
    }, GH_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function GET(req: NextRequest) {
  const directory = req.nextUrl.searchParams.get("directory") ?? process.cwd();
  try {
    const ver = await runGh(directory, ["--version"]);
    return NextResponse.json({
      available: ver.code === 0,
      version: ver.stdout.trim().split(/\r?\n/)[0] ?? null,
    });
  } catch {
    return NextResponse.json({
      available: false,
      version: null,
      hint: "Install GitHub CLI (gh) and run gh auth login",
    });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    directory?: string;
    title?: string;
    body?: string;
    base?: string;
    push?: boolean;
  } | null;

  if (!body?.directory || !body.title?.trim()) {
    return NextResponse.json(
      { error: "directory and title are required" },
      { status: 400 },
    );
  }
  if (!isAbsolutePath(body.directory)) {
    return NextResponse.json({ error: "invalid directory" }, { status: 400 });
  }

  if (body.base) {
    try {
      assertSafeBranchName(body.base);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "invalid base" },
        { status: 400 },
      );
    }
  }

  let ghAvailable = true;
  try {
    await runGh(body.directory, ["--version"]);
  } catch {
    ghAvailable = false;
  }
  if (!ghAvailable) {
    return NextResponse.json(
      {
        error: "GitHub CLI (gh) is not installed or not on PATH",
        hint: "Install gh and run: gh auth login",
      },
      { status: 503 },
    );
  }

  if (body.push !== false) {
    const push = await runGit(body.directory, ["push", "-u", "origin", "HEAD"]);
    if (push.code !== 0) {
      return NextResponse.json(
        {
          error: push.stderr.trim() || push.stdout.trim() || "git push failed",
        },
        { status: 500 },
      );
    }
  }

  const args = [
    "pr",
    "create",
    "--title",
    body.title.trim(),
    "--body",
    body.body?.trim() || body.title.trim(),
  ];
  if (body.base) {
    args.push("--base", body.base);
  }

  try {
    const pr = await runGh(body.directory, args);
    if (pr.code !== 0) {
      return NextResponse.json(
        { error: pr.stderr.trim() || pr.stdout.trim() || "gh pr create failed" },
        { status: 500 },
      );
    }
    const url = pr.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? pr.stdout.trim();
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "gh failed",
        hint: "Install GitHub CLI and authenticate",
      },
      { status: 503 },
    );
  }
}
