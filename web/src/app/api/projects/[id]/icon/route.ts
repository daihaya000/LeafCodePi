import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { decodeProjectIcon, projectIconVersion } from "@/lib/project-icon-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A project's icon as an image. `/api/projects` links here with `?v=<hash of the icon>`, so a
 * matching version is immutable and cached by the browser; a stale or missing version is served
 * uncached so an old link never pins a replaced icon.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const icon = getProject(id)?.icon;
  const decoded = decodeProjectIcon(icon);
  if (!icon || !decoded) return NextResponse.json({ error: "icon not found" }, { status: 404 });
  const current = req.nextUrl.searchParams.get("v") === projectIconVersion(icon);
  return new Response(new Uint8Array(decoded.bytes), {
    headers: {
      "Content-Type": decoded.mime,
      "Content-Length": String(decoded.bytes.byteLength),
      "Cache-Control": current ? "private, max-age=31536000, immutable" : "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}