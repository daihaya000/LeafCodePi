import { NextRequest, NextResponse } from "next/server";
import { createProfileBackup, exportProfile, importProfileWithBackup, listProfileBackups, resetProfile, restoreProfile, restoreProfilePackages } from "@/lib/profile";
import { MAX_ARCHIVE_BYTES } from "@/lib/profile-limits";

/** multipart framing slack on top of the archive limit */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

function archiveTooLarge() {
  return NextResponse.json({ error: "設定ファイルが大きすぎます" }, { status: 413 });
}

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

/**
 * Re-read an undeclared body with a hard byte ceiling. Returns null once the limit
 * is passed, so the request is refused before the whole payload is held in memory.
 */
async function requestWithinArchiveLimit(request: Request): Promise<Request | null> {
  const body = request.body;
  if (!body) return request;
  const limit = MAX_ARCHIVE_BYTES + MULTIPART_OVERHEAD_BYTES;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buffered = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: buffered,
  });
}

export async function POST(request: NextRequest) {
  if (localRuntimeBlocked()) return profileMutationUnavailable();
  try {
    // A declared content-length is refused outright; an undeclared (chunked) body
    // is re-read under a byte ceiling so formData() never holds the whole payload.
    const declaredHeader = request.headers.get("content-length");
    const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES + MULTIPART_OVERHEAD_BYTES) return archiveTooLarge();
    const formRequest = Number.isFinite(declared) ? request : await requestWithinArchiveLimit(request);
    if (formRequest === null) return archiveTooLarge();
    const form = await formRequest.formData();
    const file = form.get("profile");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "設定ファイルを指定してください" }, { status: 400 });
    }
    if (file.size > MAX_ARCHIVE_BYTES) return archiveTooLarge();
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
