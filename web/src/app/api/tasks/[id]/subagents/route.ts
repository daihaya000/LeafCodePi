import { NextRequest, NextResponse } from "next/server";
import { listSubagentRuns } from "@/lib/pi/subagent-runs";
import { getTask } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** サブエージェント（pi-subagents）子実行のライブ進捗。 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
    const sinceRaw = req.nextUrl.searchParams.get("since");
    const since = sinceRaw !== null ? Number(sinceRaw) : NaN;
    const runs = listSubagentRuns({
      sessionFile: task.sessionFile,
      cwd: task.directory,
      ...(Number.isFinite(since) ? { sinceMs: since } : {}),
    });
    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "サブエージェントの進捗を取得できませんでした" },
      { status: 500 },
    );
  }
}
