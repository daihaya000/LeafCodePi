import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isAbsolutePath } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function hasGitDir(directory: string): Promise<boolean> {
  try {
    const git = await stat(join(directory, ".git"));
    return git.isDirectory() || git.isFile();
  } catch {
    return false;
  }
}

/** List the opened folder itself and its immediate Git repositories. */
export async function GET(req: NextRequest) {
  const directory = req.nextUrl.searchParams.get("directory");
  if (!directory || !isAbsolutePath(directory)) {
    return NextResponse.json({ error: "directory is required" }, { status: 400 });
  }

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const children = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const childPath = join(directory, entry.name);
          return (await hasGitDir(childPath))
            ? { path: childPath, name: entry.name }
            : null;
        }),
    );
    const repositories = children
      .filter(
        (repository): repository is { path: string; name: string } => repository !== null,
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    if (await hasGitDir(directory)) {
      repositories.unshift({ path: directory, name: basename(directory) || directory });
    }
    return NextResponse.json({ repositories });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not list repositories" },
      { status: 400 },
    );
  }
}
