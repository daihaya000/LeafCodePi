import { NextRequest, NextResponse } from "next/server";
import { createProfileBackup, exportProfile, importProfile, listProfileBackups, resetProfile, restoreProfile } from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function profileFilename(): string {
  return `leafcode-pi-profile-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.lcp.gz`;
}

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.has("backups")) {
      return NextResponse.json({ backups: listProfileBackups() }, { headers: { "cache-control": "no-store" } });
    }
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

export async function PATCH() {
  try {
    return NextResponse.json({ ok: true, ...createProfileBackup() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "プロファイルのバックアップに失敗しました" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as { backup?: unknown };
    if (typeof body.backup !== "string") {
      return NextResponse.json({ error: "復元するバックアップを指定してください" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...restoreProfile(body.backup) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "プロファイルの復元に失敗しました" },
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
