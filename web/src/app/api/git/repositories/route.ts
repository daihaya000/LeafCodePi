import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { gitDirectoryError } from "@/lib/git";

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
  const directoryError = gitDirectoryError(directory);
  if (directoryError) {
    return NextResponse.json(
      { error: directoryError },
      { status: directoryError === "directory is not allowed" ? 403 : 400 },
    );
  }
  const dir = directory!;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const children = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const childPath = join(dir, entry.name);
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
    if (await hasGitDir(dir)) {
      repositories.unshift({ path: dir, name: basename(dir) || dir });
    }
    return NextResponse.json({ repositories });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not list repositories" },
      { status: 400 },
    );
  }
}
