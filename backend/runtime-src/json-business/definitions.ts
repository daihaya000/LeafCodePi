import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { configurationCommands } from "../configuration/commands";
import { configurationRequest } from "../configuration/http";
import { reloadLiveSessionsContext, refreshLiveSessionsForAgentDefinition } from "../lib/pi/harness";
import type { JsonBusinessInput } from "./index";
import * as agents from "./handlers/agents/route";
import * as agent from "./handlers/agents/[name]/route";
import * as skills from "./handlers/skills/route";
import * as skill from "./handlers/skills/[name]/route";
import * as extensions from "./handlers/extensions/route";
import * as extension from "./handlers/extensions/[name]/route";
import * as agentsMd from "./handlers/agents-md/route";
import * as botsMd from "./handlers/bots-md/route";
import * as soulMd from "./handlers/soul-md/route";
import * as userMd from "./handlers/user-md/route";
import * as toolsMd from "./handlers/tools-md/route";
import * as designMd from "./handlers/design-md/route";
import * as workflowMd from "./handlers/workflow-md/route";
import * as prompts from "./handlers/prompts/transfer/route";

type Handler = (req: ReturnType<typeof configurationRequest>, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const handlers = { agents, "agents/[name]": agent, skills, "skills/[name]": skill, extensions, "extensions/[name]": extension,
  "agents-md": agentsMd, "bots-md": botsMd, "soul-md": soulMd, "user-md": userMd, "tools-md": toolsMd,
  "design-md": designMd, "workflow-md": workflowMd, "prompts/transfer": prompts } as unknown as Record<string, Record<string, Handler>>;
const noReload = new Set(["tools-md", "design-md", "workflow-md"]);
/** Saved state is checkpointed before live application, in the same queue as Phase2 settings. */
export async function dispatchDefinitionRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: {route: string; params: Record<string, string>}): Promise<JsonBusinessResult> {
  let reload: Awaited<ReturnType<typeof reloadLiveSessionsContext>> | undefined;
  const handler = async () => {
    const response = await handlers[target.route][input.method](request, { params: Promise.resolve(target.params) });
    const body = await response.json();
    if (response.status >= 500) body.error = "定義の処理に失敗しました";
    if (body.warning) body.warning = "保存は完了しましたが復旧記録の後処理に失敗しました";
    return Response.json(body, { status: response.status, headers: response.headers });
  };
  if (input.method !== "GET" && (!input.operationId || !/^[0-9a-f-]{36}$/.test(input.operationId))) return { status: 400, headers: {}, body: { error: "Invalid operation ID" } };
  const response = input.method === "GET" ? await handler() : await configurationCommands.run({
    route: input.route, method: input.method, operationId: input.operationId, handler,
    apply: async () => {
      if (noReload.has(target.route)) return "not-required";
      reload = await reloadLiveSessionsContext();
      if (reload.failed > 0) throw new Error("Definition reload failed");
      const refresh = target.route === "agents/[name]" ? await refreshLiveSessionsForAgentDefinition(target.params.name) : undefined;
      return reload.deferred > 0 || (refresh && refresh.deferred > 0) ? "deferred" : "applied";
    },
  });
  const body = await response.json();
  if (reload) body.reload = { reloaded: reload.reloaded, deferred: reload.deferred, failed: reload.failed, errors: [] };
  const headers: Record<string, string> = {};
  for (const key of ["cache-control", "x-content-type-options"]) if (response.headers.has(key)) headers[key] = response.headers.get(key)!;
  return { status: response.status, headers, body };
}
