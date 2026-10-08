import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { createTaskCollectionCommands } from "@backend-core/task-collection-command.mjs";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { join } from "node:path";
import { dataDir } from "../lib/paths";
import { configurationRequest } from "../configuration/http";
import * as tasks from "./handlers/tasks/route";
import type { JsonBusinessInput } from "./index";
const commands = createTaskCollectionCommands({ ledgerPath: () => join(dataDir(), "task-collection-command.json") });
type Handler = (request: ReturnType<typeof configurationRequest>) => Promise<Response>;
const handlers = tasks as unknown as Record<string, Handler>;
/** Admission precedes Auto generation/session/teardown. Accepted commands survive client disconnect. */
export async function dispatchTaskCollectionRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  const handler = async () => {
    const response = await handlers[input.method](request);
    if (response.status === 304) return response;
    const body = await response.json();
    if (response.status >= 500) body.error = "タスクの処理に失敗しました";
    return Response.json(body, { status: response.status, headers: response.headers });
  };
  const response = input.method === "GET" ? await handler() : await commands.run({ operationId: input.operationId, handler });
  const headers: Record<string, string> = {};
  for (const key of ["cache-control", "etag"]) if (response.headers.has(key)) headers[key] = response.headers.get(key)!;
  return { status: response.status, headers, body: response.status === 304 ? null : await response.json() };
}
