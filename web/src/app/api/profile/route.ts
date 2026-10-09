import { NextRequest } from "next/server";
import { relayConfiguration } from "@/lib/configuration-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { exportProfile, listProfileBackups } from "@/lib/profile";

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


export function POST(request: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "POST" }), "profile");
}

export function PATCH(request: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "PATCH" }), "profile");
}

export function PUT(request: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "PUT" }), "profile");
}

export function DELETE(request?: NextRequest) {
  return relayConfiguration(request ?? new Request("http://127.0.0.1/api/profile", { method: "DELETE" }), "profile");
}
