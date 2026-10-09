import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getTask } from "../../../../../lib/store";
import { explorerControlUrl } from "../../../../../lib/explorer-metadata";
export async function GET(_request: Request, context: { params: Promise<{id: string}> }) {
  assertConfigurationOwner();
  const { id } = await context.params;
  const item = getTask(id);
  if (!item) return Response.json({ error: "タスクが見つかりません" }, { status: 404 });
  if (item.kind === "bot") return Response.json({ error: "Botの作業フォルダーは対象外です" }, { status: 403 });
  if (!item.directory.trim()) return Response.json({ error: "タスクの作業フォルダーが見つかりません" }, { status: 404 });
  return Response.json({ controlUrl: explorerControlUrl(), path: item.directory }, { headers: { "cache-control": "no-store" } });
}
