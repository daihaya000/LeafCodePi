import { join } from "node:path";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { serviceBusinessTarget, serviceBusinessBodyLimit, publicServiceBusinessBody } from "@shared/service-business-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import type { JsonBusinessInput } from "./index";
import { dataDir } from "../lib/paths";
import * as tasks from "./handlers/backend/tasks/route";
import * as preview from "./handlers/link-preview/route";
import * as translation from "./handlers/translation/reasoning/route";
import * as projectExplorer from "./handlers/projects/[id]/explorer/route";
import * as taskExplorer from "./handlers/tasks/[id]/explorer/route";
const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir(), "reasoning-translation-command.json") });
type Handler = (request: Request) => Response | Promise<Response>;
const handlers: Record<string, Handler> = {
  "backend/tasks": tasks.GET, "link-preview": preview.POST,
  "translation/reasoning": translation.POST,
};
export async function dispatchServiceBusinessRequest(input: JsonBusinessInput, request: Request): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if (process.env.LEAFCODE_PI_WEBUI_AUTH === "required" && !input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
  if ((input.body?.byteLength ?? 0) > serviceBusinessBodyLimit(input.route)) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const invoke = async () => {
    try {
      const target = serviceBusinessTarget(input.route)!;
      const response = target.route.endsWith("/explorer")
        ? await (target.route.startsWith("projects/") ? projectExplorer : taskExplorer).GET(request, { params: Promise.resolve({ id: target.params.id }) })
        : await handlers[input.route](request);
      const body = publicServiceBusinessBody(target.route, await response.json(), response.status);
      return body ? Response.json(body, { status: response.status }) : Response.json({ error: "Backend処理の結果を確認できません" }, { status: 503 });
    } catch { return Response.json({ error: "Backend処理の結果を確認できません" }, { status: 503 }); }
  };
  // Preview/task reads have no receipt. Translation may infer and persist Host cache/quality records.
  const response = input.route === "translation/reasoning" ? await commands.run({ operationId: input.operationId, handler: invoke }) : await invoke();
  return { status: response.status, headers: {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  }, body: await response.json() };
}
