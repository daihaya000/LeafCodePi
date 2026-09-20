import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { needsToolSearch, registerDeferredTools, TOOL_SEARCH_NAME } from "./deferred-tools";

type SearchTool = {
  name: string;
  execute: (id: string, args: { query: string }) => Promise<{
    details: { matches: string[]; added: string[] };
  }>;
};

const optionalTools = ["bash", "memory_add", "memory_replace", "memory_remove", "skill_manage", "web_search", "source_check", "fetch_content", "get_search_content", "intercom"];

function setup(initial: string[], allowedTools?: readonly string[] | (() => readonly string[])) {
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
  registerDeferredTools(pi as unknown as ExtensionAPI, allowedTools);
  return {
    get active() { return active; },
    search: tools.find(({ name }) => name === TOOL_SEARCH_NAME)!,
    start: () => handlers.session_start?.forEach((handler) => handler()),
  };
}

describe("deferred tools", () => {
  it("does not widen an agent allowlist without an optional tool", () => {
    expect(needsToolSearch(["read", "grep"])).toBe(false);
    for (const name of optionalTools) expect(needsToolSearch(["read", name])).toBe(true);
  });

  it("starts with the loader but removes low-frequency schemas", () => {
    const core = ["read", "write", "edit", "grep", "find", "ls", "powershell", "todowrite", "question", "memory_search", "session_search", "jev_judge", "mcp"];
    const state = setup([...core, ...optionalTools]);
    state.start();
    expect(state.active).toEqual([...core, TOOL_SEARCH_NAME]);
  });

  it.each(optionalTools)(
    "activates only the requested registered tool: %s",
    async (name) => {
      const state = setup(["read", ...optionalTools]);
      state.start();

      const result = await state.search.execute("tc-1", { query: name });

      expect(result.details).toEqual({ matches: [name], added: [name] });
      expect(state.active).toEqual(["read", TOOL_SEARCH_NAME, name]);
      expect((await state.search.execute("tc-2", { query: name.toUpperCase() })).details).toEqual({ matches: [name], added: [] });
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

  it("does not let a Bot tool search re-enable a disabled deferred tool", async () => {
    const state = setup(["read", "bash"], ["read", TOOL_SEARCH_NAME]);
    state.start();

    const result = await state.search.execute("tc-1", { query: "bash" });

    expect(result.details).toEqual({ matches: [], added: [] });
    expect(state.active).toEqual(["read", TOOL_SEARCH_NAME]);
  });

  it("does not add tool_search when the Bot did not allow it", () => {
    const state = setup(["read", "bash"], ["read"]);
    state.start();
    expect(state.active).toEqual(["read"]);
  });

  it("keeps permitted optional tools usable when tool_search itself is disabled", async () => {
    const state = setup(["read", TOOL_SEARCH_NAME, "memory_add", "web_search", "intercom"], ["read", "memory_add", "web_search"]);
    state.start();
    expect(state.active).toEqual(["read", "memory_add", "web_search"]);
    expect((await state.search.execute("tc", { query: "intercom" })).details.matches).toEqual([]);
  });

  it.each([
    ["ウェブ検索", "web_search"],
    ["出典の裏取り", "source_check"],
    ["YouTube動画", "fetch_content"],
    ["追加本文", "get_search_content"],
    ["他セッションと連携", "intercom"],
  ])("discovers a capability: %s", async (query, name) => {
    const state = setup(["read", ...optionalTools]);
    state.start();
    expect((await state.search.execute("tc", { query })).details.matches).toEqual([name]);
  });

  it("rechecks applied permissions for every search, including newly enabled tools", async () => {
    let allowed = ["read", TOOL_SEARCH_NAME, "web_search"];
    const state = setup(["read", ...optionalTools], () => allowed);
    state.start();
    allowed = ["read", TOOL_SEARCH_NAME, "fetch_content"];
    expect((await state.search.execute("tc", { query: "web_search" })).details.matches).toEqual([]);
    expect((await state.search.execute("tc", { query: "fetch_content" })).details.added).toEqual(["fetch_content"]);
    allowed = ["read", "web_search"];
    expect((await state.search.execute("tc", { query: "web_search" })).details.matches).toEqual([]);
  });

  it("does not activate absent or disallowed optional tools", async () => {
    const state = setup(["read", "web_search"], ["read", TOOL_SEARCH_NAME]);
    state.start();
    for (const query of ["web_search", "fetch_content", "", "unknown capability"]) {
      expect((await state.search.execute("tc", { query })).details).toEqual({ matches: [], added: [] });
    }
    expect(state.active).toEqual(["read", TOOL_SEARCH_NAME]);
  });
});
