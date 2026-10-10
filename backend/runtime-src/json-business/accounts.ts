import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { configurationCommands } from "../configuration/commands";
import { configurationRequest } from "../configuration/http";
import { invalidateHealthCache } from "../lib/pi/harness";
import type { JsonBusinessInput } from "./index";
import * as accounts from "./handlers/accounts/route";
import * as account from "./handlers/accounts/[id]/route";
import * as auth from "./handlers/accounts/[id]/auth-status/route";
import * as anthropicCookie from "./handlers/accounts/[id]/anthropic-cookie/route";
import * as anthropicBaseline from "./handlers/accounts/[id]/anthropic-baseline/route";
import * as ollamaCookie from "./handlers/accounts/[id]/ollama-cookie/route";
import * as openCodeCookie from "./handlers/accounts/[id]/opencode-go-cookie/route";
import * as openRouterBaseline from "./handlers/accounts/[id]/openrouter-baseline/route";
import * as openRouterCredits from "./handlers/accounts/[id]/openrouter-credits/route";
import * as openDesignCookie from "./handlers/accounts/[id]/opendesign-cookie/route";

type Handler = (request: ReturnType<typeof configurationRequest>, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const handlers = { accounts, "accounts/[id]": account, "accounts/[id]/auth-status": auth,
  "accounts/[id]/anthropic-cookie": anthropicCookie, "accounts/[id]/anthropic-baseline": anthropicBaseline,
  "accounts/[id]/ollama-cookie": ollamaCookie, "accounts/[id]/opencode-go-cookie": openCodeCookie,
  "accounts/[id]/opendesign-cookie": openDesignCookie,
  "accounts/[id]/openrouter-baseline": openRouterBaseline, "accounts/[id]/openrouter-credits": openRouterCredits,
} as unknown as Record<string, Record<string, Handler>>;
/** Account records and private credentials share the configuration owner queue, save observation and result ledger. */
export async function dispatchAccountRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  const handler = async () => {
    const response = await handlers[target.route][input.method](request, { params: Promise.resolve(target.params) });
    const body = await response.json();
    if (response.status >= 500) body.error = "アカウントの処理に失敗しました";
    return Response.json(body, { status: response.status, headers: response.headers });
  };
  if (input.method !== "GET" && (!input.operationId || !/^[0-9a-f-]{36}$/.test(input.operationId))) return { status: 400, headers: {}, body: { error: "Invalid operation ID" } };
  const response = input.method === "GET" ? await handler() : await configurationCommands.run({
    route: input.route, method: input.method, operationId: input.operationId, handler,
    apply: async () => { invalidateHealthCache(); return "not-required"; },
  });
  return { status: response.status, headers: { "cache-control": "no-store" }, body: await response.json() };
}
