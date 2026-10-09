import type { ConfigurationRequest } from "../../../../../configuration/http";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readTaskSubagentRuns } from "../../../../../lib/task-supervision";
import { jsonError } from "../../../../../lib/pi/harness";
/** Child transcript progress is read-only and never hydrates a parent/child SDK session. */
export async function GET(req: ConfigurationRequest, context: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  try {
    const { id } = await context.params, raw = req.nextUrl.searchParams.get("since");
    const since = raw !== null ? Number(raw) : NaN;
    return Response.json({ runs: readTaskSubagentRuns(id, Number.isFinite(since) ? since : undefined) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return Response.json({ error: status >= 500 ? "子実行の進捗を取得できませんでした" : message }, { status });
  }
}
