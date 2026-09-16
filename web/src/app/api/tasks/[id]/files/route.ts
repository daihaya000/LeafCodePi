import { NextRequest, NextResponse } from "next/server";
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  resolveWorkspaceRoot,
} from "@/lib/project-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * タスクの作業フォルダー内ファイルの一覧（`path`）と内容（`path` + `read=1`）。
 * ルートはプロジェクトルート、プロジェクトなしタスクは作業ディレクトリ。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const resolved = resolveWorkspaceRoot({ kind: "task", id });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const search = req.nextUrl.searchParams;
  const path = search.get("path")?.trim() ?? "";
  const result =
    search.get("read") === "1"
      ? readWorkspaceFile(resolved.root, path)
      : listWorkspaceEntries(resolved.root, path);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  // クライアント（ProjectFilePicker）はラッパーなしの payload をそのまま読む。
  const payload = "listing" in result ? result.listing : result.file;
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
