import { join } from "node:path";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { usageExternalCommand } from "@shared/usage-contract.mjs";
import { createUsageCommands } from "@backend-core/usage-command.mjs";
import { configurationCommands } from "../configuration/commands";
import { configurationRequest } from "../configuration/http";
import { dataDir } from "../lib/paths";
import type { JsonBusinessInput } from "./index";
import * as providers from "./handlers/codexbar/providers/route";
import * as usage from "./handlers/codexbar/usage/route";
import * as reset from "./handlers/codexbar/reset-credits/route";

type Handler = (request: ReturnType<typeof configurationRequest>) => Promise<Response>;
const handlers = { "codexbar/providers": providers, "codexbar/usage": usage, "codexbar/reset-credits": reset } as unknown as Record<string, Record<string, Handler>>;
const commands = createUsageCommands({ ledgerPath: () => join(dataDir(), "usage-command.json") });
/** The owner assembles usage/telemetry and executes external redemption. A subscriber never owns shared polling. */
export async function dispatchUsageRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>): Promise<JsonBusinessResult> {
  const handler = async () => {
    if (input.operationId) request.headers.set("x-leafcode-usage-operation", input.operationId);
    const response = await handlers[input.route][input.method](request);
    const body = await response.json();
    if (response.status >= 500) body.error = "利用量・クレジットの処理に失敗しました";
    if (input.route === "codexbar/usage" && Array.isArray(body.providers)) {
      body.providers = body.providers.map((row: Record<string, unknown>) => ({ ...row, error: row.error ? "プロバイダーの利用量を取得できません" : row.error }));
    }
    return Response.json(body, { status: response.status });
  };
  if (input.method !== "GET" && (!input.operationId || !/^[0-9a-f-]{36}$/.test(input.operationId))) return { status: 400, headers: {}, body: { error: "Invalid operation ID" } };
  const response = usageExternalCommand(input.route, input.method) ? await commands.run({ operationId: input.operationId, handler })
    : input.method !== "GET" ? await configurationCommands.run({ route: input.route, method: input.method, operationId: input.operationId, handler, apply: async () => "not-required" })
    : await handler();
  return { status: response.status, headers: { "cache-control": "no-store" }, body: await response.json() };
}
