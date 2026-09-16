import { NextRequest, NextResponse } from "next/server";
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  resolveWorkspaceRoot,
} from "@/lib/project-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** プロジェクト内ファイルの一覧（`path`）と内容（`path` + `read=1`）。ルートは登録済みプロジェクトのみ。 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const resolved = resolveWorkspaceRoot({ kind: "project", id });
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
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
