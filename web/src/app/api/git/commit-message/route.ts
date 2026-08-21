import { NextRequest, NextResponse } from "next/server";
import { isAbsolutePath } from "@/lib/paths";
import { suggestCommitMessage } from "@/lib/commit-message";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InputFile = {
  path?: unknown;
  untracked?: unknown;
};

function normalizeFiles(value: unknown): InputFile[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).filter((file): file is InputFile => {
    if (!file || typeof file !== "object") return false;
    const path = (file as InputFile).path;
    return typeof path === "string" && path.length > 0 && path.length <= 500;
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const directory = typeof body?.directory === "string" ? body.directory : "";
  if (!directory || !isAbsolutePath(directory)) {
    return NextResponse.json({ error: "directory is required" }, { status: 400 });
  }
  const files = normalizeFiles(body?.files);
  if (files.length === 0) {
    return NextResponse.json({ error: "files are required" }, { status: 400 });
  }

  const message = suggestCommitMessage(
    files.map((f) => ({
      path: String(f.path),
      untracked: f.untracked === true,
    })),
  );
  if (!message) {
    return NextResponse.json({ error: "could not suggest a message" }, { status: 400 });
  }
  return NextResponse.json({ message });
}
