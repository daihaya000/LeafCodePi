import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getProject } from "../../../../../lib/store";
import { explorerControlUrl } from "../../../../../lib/explorer-metadata";
export async function GET(_request: Request, context: { params: Promise<{id: string}> }) {
  assertConfigurationOwner();
  const { id } = await context.params;
  const item = getProject(id);
  if (!item) return Response.json({ error: "プロジェクトが見つかりません" }, { status: 404 });
  return Response.json({ controlUrl: explorerControlUrl(), path: item.rootPath }, { headers: { "cache-control": "no-store" } });
}
