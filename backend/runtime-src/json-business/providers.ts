import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { configurationCommands } from "../configuration/commands";
import { configurationRequest } from "../configuration/http";
import { invalidateHealthCache } from "../lib/pi/harness";
import type { JsonBusinessInput } from "./index";
import * as models from "./handlers/models/route";
import * as providers from "./handlers/providers/route";
import * as provider from "./handlers/providers/[id]/route";
import * as endpoints from "./handlers/providers/[id]/base-url/route";
import * as catalog from "./handlers/provider-models/route";
import * as model from "./handlers/provider-models/[key]/route";
import * as order from "./handlers/provider-models/order/route";

type Handler = (request: ReturnType<typeof configurationRequest>, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const handlers = { models, providers, "providers/[id]": provider, "providers/[id]/base-url": endpoints,
  "provider-models": catalog, "provider-models/[key]": model, "provider-models/order": order } as unknown as Record<string, Record<string, Handler>>;
/** Provider/model configuration shares the settings/definitions owner queue and durable result ledger. */
export async function dispatchProviderRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  const handler = async () => {
    const response = await handlers[target.route][input.method](request, { params: Promise.resolve(target.params) });
    const body = await response.json();
    if (response.status >= 500 || (input.method === "GET" && response.status >= 400)) body.error = "モデル・プロバイダーの処理に失敗しました";
    return Response.json(body, { status: response.status, headers: response.headers });
  };
  if (input.method !== "GET" && (!input.operationId || !/^[0-9a-f-]{36}$/.test(input.operationId))) return { status: 400, headers: {}, body: { error: "Invalid operation ID" } };
  const response = input.method === "GET" ? await handler() : await configurationCommands.run({
    route: input.route, method: input.method, operationId: input.operationId, handler,
    apply: async () => {
      invalidateHealthCache();
      // Native provider base URLs are construction-time values: never claim live application.
      if (target.route === "providers/[id]/base-url") return "deferred";
      // Model flags/order/hints and routing are read dynamically; no session replacement is needed.
      return "not-required";
    },
  });
  const headers: Record<string, string> = {};
  for (const key of ["cache-control", "x-content-type-options"]) if (response.headers.has(key)) headers[key] = response.headers.get(key)!;
  return { status: response.status, headers, body: await response.json() };
}
