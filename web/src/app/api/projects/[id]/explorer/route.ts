import { NextResponse } from "next/server";
import { resolveHostControlUrl } from "@/lib/host-control";
import { getProjects } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProjects(true).find((candidate) => candidate.id === id);
  if (!project) return NextResponse.json({ error: "プロジェクトが見つかりません" }, { status: 404 });
  return NextResponse.json(
    { controlUrl: resolveHostControlUrl(), path: project.rootPath },
    { headers: { "cache-control": "no-store" } },
  );
}

/** Explorer起動はブラウザからloopback専用ホスト制御へ直接送る。 */
export async function POST() {
  return NextResponse.json(
    { error: "ExplorerはホストPCからのみ起動できます" },
    { status: 403 },
  );
}
