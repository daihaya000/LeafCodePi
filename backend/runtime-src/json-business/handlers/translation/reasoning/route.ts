import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { translateReasoningAtHost } from "../../../../lib/reasoning-translation-owner";
export async function POST(request: Request) {
  assertConfigurationOwner();
  let body;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 64 * 1024) return Response.json({ error: "本文が大きすぎます" }, { status: 413 });
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return Response.json({ error: "texts must contain 1-16 short strings" }, { status: 400 }); }
  const texts = body?.texts;
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > 16 ||
      texts.some(text => typeof text !== "string" || !text.trim()) ||
      texts.reduce((n, text) => n + text.length, 0) > 16_000) return Response.json({ error: "texts must contain 1-16 short strings" }, { status: 400 });
  try { return Response.json(await translateReasoningAtHost(texts)); }
  // The Host may have generated/cache-written already. No false completion or error-detail leak.
  catch { return Response.json({ error: "ローカル翻訳の結果を確認できません" }, { status: 503 }); }
}
