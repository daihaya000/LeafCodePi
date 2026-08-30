import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getProjects } from "@/lib/pi/harness";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProjects(true).find((candidate) => candidate.id === id);
  if (!project) return NextResponse.json({ error: "プロジェクトが見つかりません" }, { status: 404 });
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "エクスプローラーはWindowsでのみ利用できます" }, { status: 501 });
  }

  try {
    const child = spawn("explorer.exe", [project.rootPath], { detached: true, stdio: "ignore" });
    child.unref();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "エクスプローラーを起動できませんでした" }, { status: 500 });
  }
}
