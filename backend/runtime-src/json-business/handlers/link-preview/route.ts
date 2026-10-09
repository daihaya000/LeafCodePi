import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getLinkPreview } from "@/lib/link-preview";
import { normalizeLinkUrl } from "@/lib/link-preview-shared";
const reply = (body: unknown, options?: { status: number }) => Response.json(body, { ...options, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
export async function POST(request: Request) {
  assertConfigurationOwner();
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return reply({ error: "JSONでURLを指定してください" }, { status: 415 });
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 32 * 1024) return reply({ error: "URLが長すぎます" }, { status: 413 });
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const url = normalizeLinkUrl(payload?.url);
    if (!url) return reply({ error: "HTTP/HTTPSのURLを指定してください" }, { status: 400 });
    return reply(await getLinkPreview(url));
  } catch { return reply({ error: "プレビューを取得できません" }, { status: 400 }); }
}
