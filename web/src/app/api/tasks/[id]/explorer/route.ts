import { NextResponse } from "next/server";
import { resolveHostControlUrl } from "@/lib/host-control";
import { getTask } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
  if (task.kind === "bot") {
    return NextResponse.json({ error: "Botの作業フォルダーは対象外です" }, { status: 403 });
  }
  if (!task.directory.trim()) {
    return NextResponse.json({ error: "タスクの作業フォルダーが見つかりません" }, { status: 404 });
  }
  return NextResponse.json(
    { controlUrl: resolveHostControlUrl(), path: task.directory },
    { headers: { "cache-control": "no-store" } },
  );
}
