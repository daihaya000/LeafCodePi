import { NextRequest, NextResponse } from "next/server";
import { readTaskLocalImage } from "@/lib/local-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve a task-local raster image referenced by an agent's Markdown message. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const path = req.nextUrl.searchParams.get("path") ?? "";
  const image = readTaskLocalImage(id, path);
  if (!image.ok) {
    return NextResponse.json({ error: image.error }, { status: image.status });
  }
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "content-type": image.mime,
      "content-length": String(image.bytes.length),
      "content-disposition": "inline",
      "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
}
