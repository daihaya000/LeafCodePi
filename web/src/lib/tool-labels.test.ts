import { describe, expect, it } from "vitest";
import { skillNameFromReadInput, toolInputFields, toolLabel, toolSummary } from "./tool-labels";

describe("toolLabel", () => {
  it("maps pi tools to Japanese labels", () => {
    expect(toolLabel("bash")).toBe("コマンド");
    expect(toolLabel("powershell")).toBe("コマンド");
    expect(toolLabel("read")).toBe("読取");
    expect(toolLabel("edit")).toBe("編集");
    expect(toolLabel("todowrite")).toBe("ToDo");
    expect(toolLabel("grep")).toBe("検索");
    expect(toolLabel("ls")).toBe("一覧");
    expect(toolLabel("subagent")).toBe("サブエージェント");
  });

  it("maps memory and web access tools", () => {
    expect(toolLabel("memory_search")).toBe("メモリ検索");
    expect(toolLabel("memory_add")).toBe("メモリ追加");
    expect(toolLabel("memory_replace")).toBe("メモリ更新");
    expect(toolLabel("memory_remove")).toBe("メモリ削除");
    expect(toolLabel("session_search")).toBe("セッション検索");
    expect(toolLabel("skill_manage")).toBe("スキル管理");
    expect(toolLabel("tool_search")).toBe("ツール検索");
    expect(toolLabel("web_search")).toBe("Web検索");
    expect(toolLabel("source_check")).toBe("出典確認");
    expect(toolLabel("fetch_content")).toBe("Web取得");
    expect(toolLabel("get_search_content")).toBe("検索結果取得");
    expect(toolLabel("contact_supervisor")).toBe("親エージェント連絡");
    expect(toolLabel("subagent_wait")).toBe("サブエージェント待機");
    expect(toolLabel("structured_output")).toBe("構造化出力");
    expect(toolLabel("watchdog_warn")).toBe("監視警告");
  });

  it("maps SKILL.md reads to the skill label", () => {
    const input = { path: "C:\\Users\\Daichi\\.pi\\agent\\skills\\bug-hunt\\SKILL.md" };
    expect(skillNameFromReadInput("read", input)).toBe("bug-hunt");
    expect(toolLabel("read", input)).toBe("スキル");
  });

  it("keeps unknown tool names as-is", () => {
    expect(toolLabel("mcp__x__y")).toBe("mcp__x__y");
  });
});

describe("toolSummary", () => {
  it("ignores a title that only repeats the tool name", () => {
    expect(
      toolSummary("bash", { status: "running", title: "bash", input: { command: "ls -la" } }),
    ).toBe("ls -la");
    expect(
      toolSummary("powershell", { status: "running", title: "powershell", input: { command: "Get-ChildItem" } }),
    ).toBe("Get-ChildItem");
  });

  it("prefers a real title", () => {
    expect(toolSummary("bash", { status: "running", title: "依存を導入" })).toBe("依存を導入");
  });

  it("uses path for file tools and pattern for search", () => {
    expect(toolSummary("read", { status: "completed", input: { path: "src/a.ts" } })).toBe(
      "src/a.ts",
    );
    expect(toolSummary("grep", { status: "completed", input: { pattern: "foo" } })).toBe("foo");
  });

  it("summarizes a loaded skill by name", () => {
    expect(
      toolSummary("read", {
        status: "completed",
        title: "read",
        input: { path: "/home/user/.pi/agent/skills/bug-hunt/SKILL.md" },
      }),
    ).toBe("bug-hunt");
  });

  it("summarizes todo progress", () => {
    expect(
      toolSummary("todowrite", {
        status: "completed",
        input: { todos: [{ status: "completed" }, { status: "pending" }] },
      }),
    ).toBe("1/2 件");
  });

  it("falls back to the tool name", () => {
    expect(toolSummary("weird", { status: "completed" })).toBe("weird");
  });

  it("uses the Pi task as the subagent summary", () => {
    expect(
      toolSummary("subagent", {
        status: "running",
        input: { agent: "debugger", task: "呼び出しテストを実行する" },
      }),
    ).toBe("呼び出しテストを実行する");
  });
});

describe("toolInputFields", () => {
  it("labels bash fields", () => {
    expect(toolInputFields("bash", { command: "ls", description: "一覧" })).toEqual([
      { label: "説明", value: "一覧" },
      { label: "コマンド", value: "ls" },
    ]);
  });

  it("renders todo entries as lines", () => {
    expect(
      toolInputFields("todowrite", {
        todos: [{ status: "pending", content: "A" }, { status: "completed", content: "B" }],
      }),
    ).toEqual([{ label: "ToDo", value: "pending A\ncompleted B" }]);
  });

  it("returns nothing without input", () => {
    expect(toolInputFields("read", undefined)).toEqual([]);
  });

  it("includes the loaded skill name for an expanded skill card", () => {
    expect(
      toolInputFields("read", {
        path: "/home/user/.pi/agent/skills/bug-hunt/SKILL.md",
      }),
    ).toEqual([
      { label: "スキル", value: "bug-hunt" },
      { label: "パス", value: "/home/user/.pi/agent/skills/bug-hunt/SKILL.md" },
    ]);
  });

  it("normalizes Pi subagent input into OpenCode-style fields", () => {
    expect(
      toolInputFields("subagent", {
        agent: "debugger",
        task: "呼び出しテストを実行する\n詳細な指示",
      }),
    ).toEqual([
      { label: "内容", value: "呼び出しテストを実行する 詳細な指示" },
      { label: "エージェント", value: "debugger" },
      { label: "指示", value: "呼び出しテストを実行する\n詳細な指示" },
    ]);
  });

  it("reads the first task from a workflow input", () => {
    expect(
      toolInputFields("subagent", {
        tasks: [{ agent: "reviewer", task: "差分を確認する" }],
      }),
    ).toEqual([
      { label: "内容", value: "差分を確認する" },
      { label: "エージェント", value: "reviewer" },
      { label: "指示", value: "差分を確認する" },
    ]);
  });
});
