import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getLinkPreviewImage } from "@/lib/link-preview";
export async function GET(request: Request) {
  assertConfigurationOwner();
  const image = await getLinkPreviewImage(new URL(request.url).searchParams.get("id") ?? "");
  return image ? Response.json({ image: { contentType: image.mime, base64: image.bytes.toString("base64") } })
    : Response.json({ error: "プレビュー画像を取得できません" }, { status: 404 });
}
