import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { MAX_MEMORY_SEARCH_QUERY_LENGTH, searchLeafCodeMemory } from "../../../lib/memory-search";
export async function POST(request: Request) {
  assertConfigurationOwner();
  const body = await request.json().catch(() => null), query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) return Response.json({ error: "検索語を入力してください" }, { status: 400 });
  if (query.length > MAX_MEMORY_SEARCH_QUERY_LENGTH) return Response.json({ error: `検索語は${MAX_MEMORY_SEARCH_QUERY_LENGTH}文字以内で入力してください` }, { status: 400 });
  return Response.json({ results: searchLeafCodeMemory(query) });
}
