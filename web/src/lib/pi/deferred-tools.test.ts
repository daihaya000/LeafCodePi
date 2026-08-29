import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerDeferredTools, TOOL_SEARCH_NAME } from "./deferred-tools";

type SearchTool = {
  name: string;
  execute: (id: string, args: { query: string }) => Promise<{
    details: { matches: string[]; added: string[] };
  }>;
};

function setup(initial: string[]) {
  let active = [...initial];
  const tools: SearchTool[] = [];
  const handlers: Record<string, Array<() => void>> = {};
  const all = [...new Set([...initial, TOOL_SEARCH_NAME])];
  const pi = {
    registerTool: (tool: unknown) => {
      const registered = tool as SearchTool;
      tools.push(registered);
      all.push(registered.name);
    },
    getAllTools: () => all.map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    on: (event: string, handler: () => void) => {
      (handlers[event] ??= []).push(handler);
    },
  };
  registerDeferredTools(pi as unknown as ExtensionAPI);
  return {
    get active() { return active; },
    search: tools.find(({ name }) => name === TOOL_SEARCH_NAME)!,
    start: () => handlers.session_start?.forEach((handler) => handler()),
  };
}

describe("deferred tools", () => {
  it("starts with the loader but removes low-frequency schemas", () => {
    const state = setup(["read", "bash", "memory_add", "memory_replace", "memory_remove", "skill_manage"]);
    state.start();
    expect(state.active).toEqual(["read", TOOL_SEARCH_NAME]);
  });

  it.each(["bash", "memory_add", "memory_replace", "memory_remove", "skill_manage"])(
    "activates only the requested registered tool: %s",
    async (name) => {
      const state = setup(["read", "bash", "memory_add", "memory_replace", "memory_remove", "skill_manage"]);
      state.start();

      const result = await state.search.execute("tc-1", { query: name });

      expect(result.details).toEqual({ matches: [name], added: [name] });
      expect(state.active).toEqual(["read", TOOL_SEARCH_NAME, name]);
    },
  );

  it("matches Japanese memory and skill requests", async () => {
    const state = setup(["read", "memory_add", "skill_manage"]);
    state.start();

    const memory = await state.search.execute("tc-1", { query: "メモリに保存" });
    const skill = await state.search.execute("tc-2", { query: "スキルを削除" });

    expect(memory.details.matches).toEqual(["memory_add"]);
    expect(skill.details.matches).toEqual(["skill_manage"]);
  });

  it("does not expose tools outside the deferred allowlist", async () => {
    const state = setup(["read", "write"]);
    state.start();

    const result = await state.search.execute("tc-1", { query: "delete files" });

    expect(result.details).toEqual({ matches: [], added: [] });
    expect(state.active).toEqual(["read", "write", TOOL_SEARCH_NAME]);
  });
});
