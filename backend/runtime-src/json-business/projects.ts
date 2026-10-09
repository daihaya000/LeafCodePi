import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { createProjectCommands } from "@backend-core/project-command.mjs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import * as projects from "./handlers/projects/route";
import type { JsonBusinessInput } from "./index";
const commands = createProjectCommands({ ledgerPath: () => join(dataDir(), "project-command.json") });
type Handler = (request: ReturnType<typeof configurationRequest>) => Promise<Response>;
const handlers = projects as unknown as Record<string, Handler>;
/** One owner queue for lifecycle commands; disconnect never cancels an admitted teardown/move. */
export async function dispatchProjectRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  const handler = async () => {
    const response = await handlers[input.method](request);
    if (response.status === 304) return response;
    const body = await response.json();
    if (response.status >= 500) body.error = "プロジェクトの処理に失敗しました";
    return Response.json(body, { status: response.status, headers: response.headers });
  };
  const response = input.method === "GET" ? await handler() : await commands.run({ operationId: input.operationId, handler });
  const headers: Record<string, string> = {};
  for (const key of ["cache-control", "etag"]) if (response.headers.has(key)) headers[key] = response.headers.get(key)!;
  return { status: response.status, headers, body: response.status === 304 ? null : await response.json() };
}
