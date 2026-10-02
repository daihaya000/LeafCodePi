import { NextRequest, NextResponse } from "next/server";
import { createProfileBackup, exportProfile, importProfileWithBackup, listProfileBackups, resetProfile, restoreProfile, restoreProfilePackages } from "@/lib/profile";

import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function profileMutationUnavailable() {
  // Profile replacement also changes mcp.json. No Backend mutation bridge exists yet;
  // never write from the production client or acknowledge a queued/local fallback.
  return NextResponse.json({
    error: "設定の変更・パッケージ復元はBackendでの実行が必要です",
    code: "RUNTIME_NOT_OWNED",
  }, { status: 503 });
}

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
      { error: error instanceof Error ? error.message : "設定のエクスポートに失敗しました" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (localRuntimeBlocked()) return profileMutationUnavailable();
  try {
    const form = await request.formData();
    const file = form.get("profile");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "設定ファイルを指定してください" }, { status: 400 });
    }
    const summary = importProfileWithBackup(Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "設定のインポートに失敗しました" },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { action?: unknown } | null;
    if (body?.action === "restore-packages") {
      if (localRuntimeBlocked()) return profileMutationUnavailable();
      return NextResponse.json({ ok: true, ...await restoreProfilePackages() });
    }
    return NextResponse.json({ ok: true, ...createProfileBackup() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "設定の処理に失敗しました" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (localRuntimeBlocked()) return profileMutationUnavailable();
  try {
    const body = await request.json() as { backup?: unknown };
    if (typeof body.backup !== "string") {
      return NextResponse.json({ error: "復元するバックアップを指定してください" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...restoreProfile(body.backup) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "設定の復元に失敗しました" },
      { status: 400 },
    );
  }
}

export async function DELETE() {
  if (localRuntimeBlocked()) return profileMutationUnavailable();
  try {
    return NextResponse.json({ ok: true, ...resetProfile() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "設定の初期化に失敗しました" },
      { status: 500 },
    );
  }
}
