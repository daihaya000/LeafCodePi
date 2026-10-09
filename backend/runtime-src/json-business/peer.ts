import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { peerCommand } from "@shared/peer-contract.mjs";
import { configurationCommands } from "../configuration/commands";
import { configurationRequest } from "../configuration/http";
import { invalidateHealthCache } from "../lib/pi/harness";
import type { JsonBusinessInput } from "./index";
import * as peers from "./handlers/peer-auth/peers/route";
import * as imports from "./handlers/peer-auth/import/route";
import * as list from "./handlers/peer-auth/list/route";
import * as resolve from "./handlers/peer-auth/resolve/route";
import * as usage from "./handlers/peer-auth/usage/route";
type Handler = (request: ReturnType<typeof configurationRequest>) => Promise<Response>;
const handlers = { "peer-auth/peers": peers, "peer-auth/import": imports, "peer-auth/list": list, "peer-auth/resolve": resolve, "peer-auth/usage": usage } as unknown as Record<string, Record<string, Handler>>;
/** Grants, audit/limiter, OAuth refresh/leases and peer imports live only in this Backend. */
export async function dispatchPeerRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>): Promise<JsonBusinessResult> {
  const handler = async () => {
    const response = await handlers[input.route][input.method](request);
    const body = await response.json();
    if (response.status >= 500) body.error = "Peerの処理に失敗しました";
    return Response.json(body, { status: response.status, headers: response.headers });
  };
  const command = peerCommand(input.route, input.method);
  if (command && (!input.operationId || !/^[0-9a-f-]{36}$/.test(input.operationId))) return { status: 400, headers: {}, body: { error: "Invalid operation ID" } };
  const response = command ? await configurationCommands.run({ route: input.route, method: input.method, operationId: input.operationId, handler,
    apply: async () => { invalidateHealthCache(); return "not-required"; },
  }) : await handler();
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (response.headers.has("retry-after")) headers["retry-after"] = response.headers.get("retry-after")!;
  return { status: response.status, headers, body: await response.json() };
}
