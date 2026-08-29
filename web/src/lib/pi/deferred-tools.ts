import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TOOL_SEARCH_NAME = "tool_search";

const DEFERRED_TOOLS = [
  { name: "bash", keywords: ["bash", "posix", "unix shell", "shell script", "シェル"] },
  { name: "memory_add", keywords: ["memory_add", "add memory", "save memory", "save preference", "remember", "save this", "メモリを追加", "メモリに保存", "記憶を保存", "覚えて"] },
  { name: "memory_replace", keywords: ["memory_replace", "replace memory", "update memory", "correct memory", "メモリを更新", "記憶を訂正"] },
  { name: "memory_remove", keywords: ["memory_remove", "remove memory", "delete memory", "forget memory", "forget this", "メモリを削除", "記憶を削除", "忘れて"] },
  { name: "skill_manage", keywords: ["skill_manage", "create skill", "update skill", "delete skill", "procedural skill", "スキルを作成", "スキルを更新", "スキルを削除"] },
] as const;

const deferredNames = new Set<string>(DEFERRED_TOOLS.map(({ name }) => name));

export function registerDeferredTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_SEARCH_NAME,
    label: "Tool Search",
    description: "Find and activate optional tools for Bash/POSIX commands, memory_add/replace/remove, or skill_manage. Call with the capability or exact tool name.",
    parameters: Type.Object({
      query: Type.String({ description: "Capability or optional tool to activate.", maxLength: 200 }),
    }),
    async execute(_toolCallId, { query }) {
      const normalized = query.toLowerCase().trim();
      const registered = new Set(pi.getAllTools().map(({ name }) => name));
      const matches = DEFERRED_TOOLS
        .filter(({ name, keywords }) => registered.has(name) && keywords.some((keyword) => normalized.includes(keyword)))
        .map(({ name }) => name);
      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));
      if (added.length > 0) pi.setActiveTools([...new Set([...active, ...added])]);

      const text = matches.length === 0
        ? `No optional tools matched: ${query}`
        : added.length > 0
          ? `Loaded tools: ${added.join(", ")}`
          : `Matching tools already active: ${matches.join(", ")}`;
      return { content: [{ type: "text" as const, text }], details: { matches, added } };
    },
  });

  pi.on("session_start", () => {
    const initial = pi.getActiveTools().filter((name) => !deferredNames.has(name));
    pi.setActiveTools([...new Set([...initial, TOOL_SEARCH_NAME])]);
  });
}
