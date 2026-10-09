import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskCollectionCommands } from "@backend-core/task-collection-command.mjs";
import { typesafeSettingsBodyLimit, publicTypesafeSettingsBody } from "@shared/typesafe-settings-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as cookie from "./handlers/typesafe-cookie/route";
import * as baseline from "./handlers/typesafe-baseline/route";
const commands = createTaskCollectionCommands({ ledgerPath: () => join(dataDir(), "typesafe-settings-command.json") });
type Handler = (request: Request) => Response | Promise<Response>;
/** Serial credential/configuration admission; ID-only receipt, no caller-disconnect rollback or automatic retry. */
export async function dispatchTypesafeSettingsRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > typesafeSettingsBodyLimit(input.route, input.method)) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const invoke = async () => {
    try {
      const handlers = (input.route === "typesafe-cookie" ? cookie : baseline) as unknown as Record<string, Handler>;
      const response = await handlers[input.method](request);
      const body = await response.json();
      if (response.status >= 500) body.error = "TypeSafe設定の処理結果を確認できません";
      const projected = publicTypesafeSettingsBody(input.route, body, response.status, input.method);
      return projected ? Response.json(projected, { status: response.status }) : Response.json({ error: "TypeSafe設定の処理結果を確認できません" }, { status: 503 });
    } catch { return Response.json({ error: "TypeSafe設定の処理結果を確認できません" }, { status: 503 }); }
  };
  const response = input.method === "GET" ? await invoke() : await commands.run({ operationId: input.operationId, handler: invoke });
  return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
}
