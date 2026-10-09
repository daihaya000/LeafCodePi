import { join } from "node:path";
import { createProviderAuthCommands } from "@backend-core/provider-auth-command.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import { dataDir } from "../lib/paths";
import { getActiveProviderLogin } from "../lib/pi/harness";
import { configurationRequest } from "../configuration/http";
import type { JsonBusinessInput } from "./index";
import * as login from "./handlers/providers/[id]/login/route";
import * as answer from "./handlers/providers/[id]/login/answer/route";
import * as callback from "./handlers/providers/[id]/login/callback/route";
import * as logout from "./handlers/providers/[id]/logout/route";
const commands = createProviderAuthCommands({ ledgerPath: () => join(dataDir(), "provider-auth-command.json") });
type Handler = (request: ReturnType<typeof configurationRequest>, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const handlers = { "providers/[id]/login": login, "providers/[id]/login/answer": answer,
  "providers/[id]/login/callback": callback, "providers/[id]/logout": logout } as unknown as Record<string, Record<string, Handler>>;
export async function dispatchProviderAuthRequest(input: JsonBusinessInput, request: ReturnType<typeof configurationRequest>, target: { route: string; params: Record<string, string> }): Promise<JsonBusinessResult> {
  const response = await commands.run({ operationId: input.operationId, handler: async () => {
    if (target.route === "providers/[id]/login/answer") {
      const body = await request.clone().json().catch(() => null);
      const sessionId = input.method === "DELETE" ? (request.nextUrl.searchParams.get("sessionId") ?? body?.sessionId) : body?.sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim()) return Response.json({ error: "sessionId が必要です" }, { status: 400 });
      const active = getActiveProviderLogin();
      if (active && (active.providerId !== target.params.id || active.sessionId !== sessionId.trim())) return Response.json({ error: "ログインセッションが一致しません" }, { status: 409 });
    }
    const result = await handlers[target.route][input.method](request, { params: Promise.resolve(target.params) });
    const body = await result.json();
    if (result.status >= 500) body.error = "認証操作の結果を確認できません。自動再実行しません";
    return Response.json(body, { status: result.status, headers: result.headers });
  } });
  return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
}
