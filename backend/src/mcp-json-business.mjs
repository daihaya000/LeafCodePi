import { join } from "node:path";
import { dataDir } from "../core/app-paths.mjs";
import { assertConfigurationOwner } from "../core/configuration-command.mjs";
import { createTaskCollectionCommands } from "../core/task-collection-command.mjs";
import { withMcpBusinessEffects } from "../core/mcp-business-effects.mjs";
import { MCP_BUSINESS_ROUTES, mcpBusinessTarget, mcpBusinessBodyLimit, validMcpBusinessName, publicMcpBusinessBody } from "../../shared/mcp-business-contract.mjs";
import { parseMcpPresetRequest } from "../../shared/mcp-preset-request.mjs";
import { parseMcpBearerSaveRequest, publicMcpBearerSaveResult } from "../../shared/mcp-bearer-save-request.mjs";
import { parseMcpHeadersSaveRequest, publicMcpHeadersSaveResult } from "../../shared/mcp-headers-save-request.mjs";
import { parseMcpOAuthStartRequest, publicMcpOAuthStartResult } from "../../shared/mcp-oauth-start-request.mjs";
import { parseMcpOAuthCompleteRequest, publicMcpOAuthCompleteResult } from "../../shared/mcp-oauth-complete-request.mjs";
import { publicMcpAuthSnapshot } from "../../shared/mcp-auth-snapshot.mjs";
import { parseMcpAuthRemoveRequest, publicMcpAuthRemoveResult } from "../../shared/mcp-auth-remove-request.mjs";
const unknown = "MCP操作の処理結果を確認できません";
const reply = (status, body) => Response.json(body, { status });
/** Node composition uses the same native/legacy actions as the existing private MCP transport. */
export function createMcpJsonBusiness(actions, { ledgerPath = () => join(dataDir(), "mcp-business-command.json") } = {}) {
  const commands = createTaskCollectionCommands({ ledgerPath });
  return async input => {
    assertConfigurationOwner();
    const target = mcpBusinessTarget(input.route);
    if (!target) return { status: 404, headers: {}, body: { error: "Unknown MCP route" } };
    if (!MCP_BUSINESS_ROUTES[target.route].includes(input.method)) return { status: 405, headers: {}, body: { error: "Method not allowed" } };
    if (!input.authorized) return { status: 401, headers: {}, body: { error: "Unauthorized" } };
    if (input.method !== "GET") {
      const headers = new Headers(input.headers), url = new URL(input.url), origin = headers.get("origin");
      let crossOrigin = headers.get("sec-fetch-site") === "cross-site";
      if (origin && origin !== url.origin) {
        const authority = value => { if (!value) return null; try { const parsed = new URL("http://" + value?.split(",")[0].trim()); return parsed.username || parsed.password ? null : parsed.host.toLowerCase(); } catch { return null; } };
        try { const parsed = new URL(origin); crossOrigin ||= ![url.host.toLowerCase(), authority(headers.get("host")), authority(headers.get("x-forwarded-host"))].includes(parsed.host.toLowerCase()); }
        catch { crossOrigin = true; }
      }
      if (crossOrigin) return { status: 403, headers: {}, body: { error: "Cross-origin request refused" } };
    }
    if ((input.body?.byteLength ?? 0) > mcpBusinessBodyLimit(input.route, input.method)) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
    const invoke = () => withMcpBusinessEffects(async started => {
      try {
        if (new URL(input.url).search) return reply(400, { error: "MCP操作はqueryを受け付けません" });
        const name = target.params.name;
        if (target.route !== "mcp" && !validMcpBusinessName(name)) return reply(400, { error: "名前が不正です" });
        let body = {};
        if (input.method !== "GET") {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(input.body ?? new Uint8Array());
            body = text.trim() ? JSON.parse(text) : input.method === "DELETE" ? {} : null;
          }
          catch { return reply(400, { error: "リクエスト本文が不正です" }); }
        }
        let action, args, project, expectedName, expectedEnabled;
        if (target.route === "mcp") {
          if (input.method === "GET") { action = actions.readMcpServerList; args = []; }
          else { const parsed = parseMcpPresetRequest(body); if (!parsed.ok) return reply(400, { error: "プリセットと必須項目を確認してください" }); action = actions.createMcpPresetAction; args = [parsed.value]; expectedName = parsed.value.preset; }
        } else if (target.route === "mcp/[name]") {
          if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean" || Object.keys(body).some(key => key !== "enabled")) return reply(400, { error: "enabled（boolean）が必要です" });
          action = actions.setMcpServerEnabledAction; args = [name, body.enabled]; expectedName = name; expectedEnabled = body.enabled;
        } else if (input.method === "GET") { action = actions.readMcpAuthStatus; args = [name]; expectedName = name; }
        else if (input.method === "DELETE") {
          const parsed = parseMcpAuthRemoveRequest(body); if (!parsed.ok) return reply(400, { error: "認証削除リクエストが不正です" });
          let removal = parsed.value;
          if (!removal.type) {
            if (typeof actions.readMcpAuthStatus !== "function") return reply(503, { error: unknown });
            const current = publicMcpAuthSnapshot(await actions.readMcpAuthStatus(name));
            if (!current || current.name !== name) return reply(503, { error: unknown });
            removal = { type: current.authType === "none" ? "bearer" : current.authType === "auto" ? "oauth" : current.authType };
          }
          action = actions.removeMcpAuthAction; args = [name, removal]; project = publicMcpAuthRemoveResult; expectedName = name;
        } else {
          const type = body?.type ?? body?.action, complete = type === "oauth" && body?.action === "complete";
          const parser = complete ? parseMcpOAuthCompleteRequest : type === "oauth" ? parseMcpOAuthStartRequest : type === "headers" ? parseMcpHeadersSaveRequest : parseMcpBearerSaveRequest;
          const parsed = parser(body); if (!parsed.ok) return reply(400, { error: "認証リクエストが不正です" });
          action = complete ? actions.completeMcpOAuthAuthAction : type === "oauth" ? actions.startMcpOAuthAuthAction : type === "headers" ? actions.saveMcpHeadersAuthAction : actions.saveMcpBearerAuthAction;
          project = complete ? publicMcpOAuthCompleteResult : type === "oauth" ? publicMcpOAuthStartResult : type === "headers" ? publicMcpHeadersSaveResult : publicMcpBearerSaveResult;
          args = [name, parsed.value]; expectedName = name;
        }
        if (typeof action !== "function") return reply(503, { error: unknown });
        const result = await action(...args), value = project ? project(result) : result;
        const projected = publicMcpBusinessBody(target.route, value, 200, input.method);
        if (!projected || (expectedName && (projected.name ?? projected.auth?.name) !== expectedName) || (expectedEnabled !== undefined && projected.enabled !== expectedEnabled)) return reply(503, { error: unknown });
        return reply(200, projected);
      } catch (error) {
        const status = !started() && [400, 404, 409].includes(error?.status) ? error.status : 503;
        return reply(status, { error: status >= 500 ? unknown : "MCP操作を実行できません" });
      }
    });
    const response = input.method === "GET" ? await invoke() : await commands.run({ operationId: input.operationId, handler: invoke });
    return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
  };
}
