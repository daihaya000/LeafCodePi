import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { COMPUTER_USE_TOOL_NAMES } from "@/lib/types";
import { todoToolVisible } from "@extensions/leafcode-todowrite/visibility";

export { COMPUTER_USE_TOOL_NAMES };
export const TOOL_SEARCH_NAME = "tool_search";

const DEFERRED_TOOLS = [
  { name: "jev_judge", keywords: ["jev", "typesafe", "typed judgment", "semantic", "意味判定", "意味的", "順位付け"] },
  { name: "session_search", keywords: ["session_search", "past session", "session history", "過去セッション", "会話履歴", "過去の会話"] },
  { name: "bash", keywords: ["bash", "posix", "unix shell", "shell script", "シェル"] },
  { name: "web_search", keywords: ["web", "internet", "search", "research", "ウェブ", "検索", "調査"] },
  { name: "source_check", keywords: ["source_check", "fact check", "verify claim", "出典", "裏取り", "ファクトチェック"] },
  { name: "fetch_content", keywords: ["fetch", "url", "pdf", "github", "youtube", "video", "ページ", "動画", "本文取得"] },
  { name: "get_search_content", keywords: ["get_search_content", "stored results", "search results", "responseid", "検索結果", "追加本文"] },
  { name: "intercom", keywords: ["intercom", "other session", "session communication", "セッション連携", "他セッション", "内線"] },
  { name: "memory_add", keywords: ["memory_add", "add memory", "save memory", "save preference", "remember", "save this", "メモリを追加", "メモリに保存", "記憶を保存", "覚えて"] },
  { name: "memory_replace", keywords: ["memory_replace", "replace memory", "update memory", "correct memory", "メモリを更新", "記憶を訂正"] },
  { name: "memory_remove", keywords: ["memory_remove", "remove memory", "delete memory", "forget memory", "forget this", "メモリを削除", "記憶を削除", "忘れて"] },
  { name: "skill_manage", keywords: ["skill_manage", "create skill", "update skill", "delete skill", "procedural skill", "スキルを作成", "スキルを更新", "スキルを削除"] },
] as const;

const deferredNames = new Set<string>(DEFERRED_TOOLS.map(({ name }) => name));

/**
 * The SDK's own `tool_search` (finds MCP tools by relevance). Only one tool can own the name, so the
 * session keeps this tool's definition here and `registerDeferredTools` delegates to it for queries
 * that are not about the optional tools above.
 */
export type NativeToolSearch = { definition?: ToolDefinition };

/** Runs `factory` with its `tool_search` registration captured into `holder` instead of registered. */
export function captureNativeToolSearch(
  factory: (api: ExtensionAPI) => void | Promise<void>,
  holder: NativeToolSearch,
  isToolAllowed?: (name: string) => boolean,
): (api: ExtensionAPI) => void | Promise<void> {
  return (api) => {
    let sessionManager: object | undefined;
    api.on("session_start", (_event, ctx) => { sessionManager = ctx.sessionManager; });
    const permitted = (name: string) => (isToolAllowed?.(name) ?? true) && todoToolVisible(sessionManager, name);
    const bound = new Map<unknown, unknown>();
    const view = new Proxy({} as ExtensionAPI, {
      get(_target, key) {
        // The factory includes codemode as well as search. Both must discover only permitted tools.
        if (key === "getAllTools") return () => api.getAllTools().filter(({ name }) => permitted(name));
        if (key === "getActiveTools") return () => api.getActiveTools().filter(permitted);
        if (key === "setActiveTools") return (names: string[]) => {
          // Hidden active names belong to the permission loadout, not the discovery view.
          api.setActiveTools([...new Set([...api.getActiveTools().filter((name) => (isToolAllowed?.(name) ?? true) && !todoToolVisible(sessionManager, name)), ...names.filter(permitted)])]);
        };
        if (key === "registerTool") {
          return (definition: ToolDefinition) => {
            if (definition?.name === TOOL_SEARCH_NAME) {
              holder.definition = definition;
              return undefined;
            }
            if (definition?.name === "codemode") {
              const prepare = definition.prepareLoadout;
              const execute = definition.execute;
              return api.registerTool({
                ...definition,
                prepareLoadout: prepare ? (loadout) => prepare({
                  ...loadout,
                  declared: loadout.declared.filter(({ name }) => permitted(name)),
                  callable: loadout.callable.filter(({ name }) => permitted(name)),
                  registered: loadout.registered.filter(({ name }) => permitted(name)),
                }) : undefined,
                execute: (id, params, signal, onUpdate, ctx) => execute(id, params, signal, onUpdate,
                  new Proxy(ctx, { get(target, key) {
                    if (key === "tools") return target.tools.filter(({ name }) => permitted(name));
                    return Reflect.get(target, key, target);
                  } })),
              });
            }
            return api.registerTool(definition);
          };
        }
        const value = Reflect.get(api, key, api);
        if (typeof value !== "function") return value;
        if (!bound.has(value)) bound.set(value, value.bind(api));
        return bound.get(value);
      },
    });
    return factory(view);
  };
}

export function registerDeferredTools(
  pi: ExtensionAPI,
  allowedTools?: readonly string[] | (() => readonly string[]),
  nativeSearch?: NativeToolSearch,
): void {
  const currentAllowlist = () => {
    const names = typeof allowedTools === "function" ? allowedTools() : allowedTools;
    return names ? new Set(names) : undefined;
  };
  pi.registerTool({
    name: TOOL_SEARCH_NAME,
    label: "Tool Search",
    description: "Find and activate optional tools: web_search (web research), source_check (fact checking), fetch_content (URL/PDF/GitHub/YouTube/video), get_search_content (stored search results), intercom (other sessions), session_search (past conversations), jev_judge (typed semantic judgments), bash (POSIX), memory_add/replace/remove, skill_manage. Also finds MCP server tools by topic. Call with the capability or exact tool name. Only permitted tools can be loaded.",
    parameters: Type.Object({
      query: Type.String({ description: "Capability or optional tool to activate.", maxLength: 200 }),
    }),
    async execute(toolCallId, { query }, signal, onUpdate, ctx) {
      const normalized = query.toLowerCase().trim();
      const registered = new Set(pi.getAllTools().map(({ name }) => name));
      const allowed = currentAllowlist();
      const exact = deferredNames.has(normalized);
      // ponytail: fixed bilingual keywords; add aliases when real searches miss.
      const matches = DEFERRED_TOOLS
        .filter(({ name, keywords }) => allowed?.has(TOOL_SEARCH_NAME) !== false && registered.has(name) && allowed?.has(name) !== false && todoToolVisible(ctx?.sessionManager, name) &&
          (exact ? name === normalized : keywords.some((keyword) => normalized.includes(keyword))))
        .map(({ name }) => name);
      const native = nativeSearch?.definition;
      const nativeAllowed = native !== undefined && allowed?.has(TOOL_SEARCH_NAME) !== false;
      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));
      if (added.length > 0) pi.setActiveTools([...new Set([...active, ...added])]);
      const optionalText = matches.length === 0
        ? null
        : added.length > 0
          ? `Loaded tools: ${added.join(", ")}`
          : `Matching tools already active: ${matches.join(", ")}`;
      // The SDK search also ranks MCP tools, which no keyword list covers. Run it even when the
      // query names an optional tool exactly: a server can expose a tool of the same name, and
      // skipping the search here lost it.
      if (native && nativeAllowed) {
        const nativeResult = await native.execute(toolCallId, { query }, signal, onUpdate, ctx);
        if (optionalText === null) return nativeResult;
        return {
          ...nativeResult,
          content: [{ type: "text" as const, text: optionalText }, ...(nativeResult.content ?? [])],
        };
      }

      return {
        content: [{ type: "text" as const, text: optionalText ?? `No optional tools matched: ${query}` }],
        details: { matches, added },
      };
    },
  });

  pi.on("session_start", () => {
    const allowed = currentAllowlist();
    const searchAllowed = allowed === undefined || allowed.has(TOOL_SEARCH_NAME);
    // A callable tool must stay in the executable loadout even if the model
    // names it directly instead of first invoking tool_search. SDK tool calls
    // against an inactive tool fail with "Tool <name> not found".
    const initial = pi.getActiveTools().filter((name) =>
      (name !== TOOL_SEARCH_NAME || searchAllowed) &&
      (!deferredNames.has(name) || allowed?.has(name) !== false));
    pi.setActiveTools(searchAllowed ? [...new Set([...initial, TOOL_SEARCH_NAME])] : initial);
  });
}
