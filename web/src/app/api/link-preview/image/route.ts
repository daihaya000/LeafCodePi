import { NextResponse } from "next/server";
import { getLinkPreviewImage } from "@/lib/link-preview";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const image = await getLinkPreviewImage(new URL(request.url).searchParams.get("id") ?? "");
  if (!image) return NextResponse.json({ error: "プレビュー画像を取得できません" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new NextResponse(new Uint8Array(image.bytes), { headers: {
    "Content-Type": image.mime, "Content-Length": String(image.bytes.length),
    "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer",
  } });
}
