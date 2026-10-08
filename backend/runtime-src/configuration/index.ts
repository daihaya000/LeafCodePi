import { join } from "node:path";
import { basename } from "node:path";
import { CONFIGURATION_ROUTES, configurationTarget } from "@shared/configuration-contract.mjs";
import { createConfigurationCommands } from "@backend-core/configuration-command.mjs";
import { dataDir } from "@/lib/paths";
import { invalidateSettingsFileCache } from "@/lib/pi/web-settings";
import { invalidateCachedUsage } from "@/lib/codexbar/cache";
import { configurationRequest } from "./http";
import { rejectUnauthorizedTransfer } from "../lib/pi/transfer-access";
import { reloadLiveSessionsContext, applyCodePermissionSettingsToLiveTasks, refreshCompactionSuggestions, invalidateHealthCache } from "@/lib/pi/harness";
import { COMPACTION_ACTION_SETTING_KEY, COMPACTION_THRESHOLD_SETTING_KEY } from "@/lib/compaction-settings";
import { CODE_PERMISSION_SETTING_KEYS } from "@/lib/pi/code-permission-settings";
import * as settings from "./handlers/settings/route";
import * as setting from "./handlers/settings/[key]/route";
import * as hang from "./handlers/settings/hang-timeout/route";
import * as intercom from "./handlers/settings/intercom/route";
import * as llama from "./handlers/settings/llama-server-config/route";
import * as safety from "./handlers/settings/system-safety/route";
import * as tts from "./handlers/settings/tts/route";
import * as transfer from "./handlers/settings/transfer/route";
import * as warming from "./handlers/cache-warming/route";
import * as compaction from "./handlers/compaction-settings/route";
import * as jev from "./handlers/jev-model/route";
import * as legacyJev from "./handlers/jev-model/legacy-credentials/route";
import * as memory from "./handlers/memory-settings/route";
import * as notifications from "./handlers/notifications/route";
import * as pushover from "./handlers/pushover/route";
import * as profile from "./handlers/profile/route";

type Handler = (request: ReturnType<typeof configurationRequest>, context: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;
const handlers = { settings, "settings/[key]": setting, "settings/hang-timeout": hang, "settings/intercom": intercom,
  "settings/llama-server-config": llama, "settings/system-safety": safety, "settings/tts": tts, "settings/transfer": transfer,
  "cache-warming": warming, "compaction-settings": compaction, "jev-model": jev, "jev-model/legacy-credentials": legacyJev,
  "memory-settings": memory, notifications, pushover, profile } as unknown as Record<string, Record<string, Handler>>;

const commands = createConfigurationCommands({
  ledgerPath: () => join(dataDir(), "configuration-command.json"),
  apply: async ({ route, method, body }) => {
    invalidateSettingsFileCache(); invalidateCachedUsage(); invalidateHealthCache();
    const target = configurationTarget(route)!;
    if (target.route === "settings/[key]") {
      const compaction = [COMPACTION_ACTION_SETTING_KEY, COMPACTION_THRESHOLD_SETTING_KEY].includes(target.params.key);
      const permissions = CODE_PERMISSION_SETTING_KEYS.has(target.params.key);
      if (compaction) refreshCompactionSuggestions();
      if (permissions) await applyCodePermissionSettingsToLiveTasks();
      return compaction || permissions ? "applied" : "not-required";
    }
    const reload = ["memory-settings", "settings/intercom", "settings/transfer"].includes(target.route)
      || (target.route === "profile" && (method !== "PATCH" || Number(body.packageCount) > 0));
    if (!reload) return "not-required";
    if (target.route === "profile") {
      refreshCompactionSuggestions();
      await applyCodePermissionSettingsToLiveTasks();
    }
    const result = await reloadLiveSessionsContext();
    if (result.failed > 0) throw new Error("Live settings reload failed");
    return result.deferred > 0 ? "deferred" : "applied";
  },
});

export type ConfigurationInput = {
  route: string; method: string; url: string; headers: Record<string, string>;
  authorized: boolean; operationId?: string; body?: Uint8Array;
};
export async function dispatchConfigurationRequest(input: ConfigurationInput, runOwnedWrite?: (action: () => Promise<Response>) => Promise<Response>): Promise<Response> {
  const target = configurationTarget(input.route);
  if (!target) return Response.json({ error: "Unknown configuration route" }, { status: 404 });
  if (!CONFIGURATION_ROUTES[target.route].includes(input.method)) return Response.json({ error: "Method not allowed" }, { status: 405 });
  const request = configurationRequest(new Request(input.url, { method: input.method, headers: input.headers,
    ...(input.body?.byteLength ? { body: new Uint8Array(input.body).slice().buffer } : {}) }), input.authorized);
  if (target.route === "profile") {
    const unauthorized = rejectUnauthorizedTransfer(request);
    if (unauthorized) return unauthorized;
  }
  if (target.route === "settings" && request.nextUrl.searchParams.has("operationId")) {
    const id = request.nextUrl.searchParams.get("operationId")!;
    if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Invalid operation ID" }, { status: 400 });
    const result = commands.read(id);
    return Response.json({ mutation: result }, { status: result ? 200 : 404 });
  }
  const handler = async () => {
    let response = await handlers[target.route][input.method](request, { params: Promise.resolve(target.params) });
    const body = await response.json();
    // Owner exception text can contain provider credentials or local paths. Only explicit DTO fields leave it.
    if (!response.ok) body.error = response.status === 413 ? "設定ファイルが大きすぎます" : response.status === 403 ? "許可されない操作です" : "設定の処理に失敗しました";
    if (typeof body.recoveryPath === "string") { body.recoveryId = basename(body.recoveryPath, ".json"); delete body.recoveryPath; }
    if (typeof body.backupPath === "string") body.backupPath = basename(body.backupPath);
    response = Response.json(body, { status: response.status, headers: response.headers });
    return response;
  };
  if (input.method === "GET") return handler();
  return commands.run({ operationId: input.operationId, route: input.route, method: input.method,
    handler: runOwnedWrite ? () => runOwnedWrite(handler) : handler });
}
