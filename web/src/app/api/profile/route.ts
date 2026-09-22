import { NextRequest, NextResponse } from "next/server";
import { exportProfile, importProfile, resetProfile } from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function profileFilename(): string {
  return `leafcode-pi-profile-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.lcp.gz`;
}

export async function GET() {
  try {
    const { archive } = exportProfile();
    return new NextResponse(new Uint8Array(archive).slice().buffer, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${profileFilename()}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "プロファイルのエクスポートに失敗しました" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("profile");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "プロファイルファイルを指定してください" }, { status: 400 });
    }
    const summary = importProfile(Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "プロファイルのインポートに失敗しました" },
      { status: 400 },
    );
  }
}

export async function DELETE() {
  try {
    return NextResponse.json({ ok: true, ...resetProfile() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "プロファイルの初期化に失敗しました" },
      { status: 500 },
    );
  }
}
