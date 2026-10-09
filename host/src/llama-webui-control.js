import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertConfigurationOwner } from "../../backend/core/configuration-command.mjs";
import { createTaskConversationCommands } from "../../backend/core/task-conversation-command.mjs";
import { parseLlamaServerSettings, LLAMA_SERVER_SETTINGS_KEY, llamaServerBaseUrl } from "../../shared/llama-server-settings.mjs";
import { publicHostLlamaBody } from "../../shared/host-llama-contract.mjs";
import { createLlamaModelCatalog } from "./llama-model-catalog.js";
import { createLlamaModelLoader } from "./llama-model-load.js";
import { parseStartBody } from "./llama-start-body.js";
/** All model selection, filesystem scans, launch validation, coalescing and admission belong to Host. */
export function createLlamaWebUiControl({ repoRoot, dataDir, service, fetch: fetcher = fetch, notifyChanged = async () => {}, waitMs = 20000 }) {
  const readSettingValue = key => { try { const value = JSON.parse(readFileSync(join(dataDir, "settings", key + ".json"), "utf8")).value; return typeof value === "string" ? value : null; } catch { return null; } };
  const catalog = createLlamaModelCatalog({ repoRoot, readSettingValue }), loader = createLlamaModelLoader(fetcher);
  const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir, "host-llama-command.json") });
  let lifecycleBusy = false, lifecycleId;
  async function handle({ action, body, url, operationId }) {
    assertConfigurationOwner();
    if (action === "models") { const response = await catalog.read({ nextUrl: new URL(url, "http://127.0.0.1") }); return { status: response.status, body: await response.json() }; }
    if (action === "status") return { status: 200, body: await service.status() };
    let input; try { input = body?.length ? JSON.parse(Buffer.from(body).toString("utf8")) : {}; } catch { return { status: 400, body: { error: "Invalid JSON" } }; }
    if (!input || typeof input !== "object" || Array.isArray(input)) return { status: 400, body: { error: "Invalid settings" } };
    const config = action === "start" ? parseStartBody(input) : {};
    if (config === null) return { status: 400, body: { error: "Invalid start settings" } };
    if (action === "ensure-loaded" && input.preferredId !== undefined && (typeof input.preferredId !== "string" || input.preferredId.length > 400)) return { status: 400, body: { error: "Invalid model ID" } };
    const lifecycle = action === "start" || action === "stop";
    if (lifecycle && lifecycleBusy) return { status: 409, body: { error: "Llama lifecycle operation in progress", operation: { id: operationId, execution: operationId === lifecycleId ? "unknown" : "not-started" } } };
    if (lifecycle) { lifecycleBusy = true; lifecycleId = operationId; }
    try {
      const response = await commands.run({ operationId, handler: async () => {
        let result;
        if (action === "ensure-loaded") {
          const settings = parseLlamaServerSettings(readSettingValue(LLAMA_SERVER_SETTINGS_KEY));
          const preferredId = input.preferredId?.trim() || basename(settings.modelFile.replace(/\\/g, "/")).replace(/\.gguf$/i, "");
          result = await loader.ensureLoaded({ preferredId, baseUrl: llamaServerBaseUrl(process.env.LEAFCODE_PI_LLAMA_PORT), waitMs });
        } else result = await service[action](config);
        await notifyChanged().catch(() => {});
        const status = result.ok ? 200 : 502, projected = publicHostLlamaBody(action, result, status);
        return Response.json(projected ?? { error: "Llama result unavailable" }, { status: projected ? status : 503 });
      } });
      const projected = publicHostLlamaBody(action, await response.json(), response.status);
      return { status: projected ? response.status : 503, body: projected ?? { error: "Llama result unavailable" } };
    } finally { if (lifecycle) { lifecycleBusy = false; lifecycleId = undefined; } }
  }
  return { handle };
}
