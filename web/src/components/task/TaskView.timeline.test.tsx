// @vitest-environment happy-dom
// タイムラインの不変条件テスト。「作業ログが分断される」「ヘッダーだけの行が出る」は
// 何度も再発しているので、個別ケースではなく契約として固定する。PartView は実物を使う。
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { TaskSummary, UiMessage, UiPart } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  apiUrl: (path: string) => path,
  botFor: vi.fn(),
}));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/ProjectExplorerButton", () => ({ ProjectExplorerButton: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({ useBotFor: () => mocks.botFor }));

import { TaskView } from "./TaskView";

const task: TaskSummary = {
  id: "timeline-task",
  projectId: null,
  projectName: "test",
  title: "timeline",
  directory: "",
  isolation: "current_folder",
  status: "idle",
  sessionId: null,
  sessionFile: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const turn = (index: number) => ({ goalId: "loop-1", turn: index, kind: "goal" as const });

function toolPart(id: string): UiPart {
  return {
    id: `${id}-tool`,
    type: "tool",
    tool: "read",
    callID: `${id}-call`,
    state: { status: "completed", input: { path: "README.md" }, output: "ok" },
  };
}

function thinkingPart(id: string): UiPart {
  return { id: `${id}-thinking`, type: "thinking", text: "考えています" };
}

function textPart(id: string, text: string): UiPart {
  return { id: `${id}-text`, type: "text", text };
}

/** 実セッションで観測した形をすべて混ぜた並び。 */
const messages: UiMessage[] = [
  { id: "user-1", role: "user", createdAt: 1, parts: [textPart("user-1", "進めて")] },
  // thinking + tool（本文なし）
  { id: "a1", role: "assistant", createdAt: 2, goalLoopTurn: turn(1), parts: [thinkingPart("a1"), toolPart("a1")] },
  // 短い前置き + tool
  { id: "a2", role: "assistant", createdAt: 3, goalLoopTurn: turn(1), parts: [textPart("a2", "次にテストを流します"), toolPart("a2")] },
  // ライブ配信中に混ざる空メッセージ（Goal Loop のターン付き）
  { id: "a3", role: "assistant", createdAt: 4, goalLoopTurn: turn(1), parts: [] },
  // 空白だけの本文
  { id: "a4", role: "assistant", createdAt: 5, goalLoopTurn: turn(1), parts: [textPart("a4", "\n")] },
  // tool だけ
  { id: "a5", role: "assistant", createdAt: 6, goalLoopTurn: turn(1), parts: [toolPart("a5")] },
  // 長い本文 + tool（前置きとみなさず枠外へ）
  { id: "a6", role: "assistant", createdAt: 7, goalLoopTurn: turn(1), parts: [textPart("a6", "結果を報告します。".repeat(40)), toolPart("a6")] },
  // thinking + 本文（ツールなし＝ターンの回答）
  { id: "a7", role: "assistant", createdAt: 8, goalLoopTurn: turn(1), parts: [thinkingPart("a7"), textPart("a7", "ターン1を完了しました")] },
  // 次のターンは空メッセージから始まる
  { id: "a8", role: "assistant", createdAt: 9, goalLoopTurn: turn(2), parts: [] },
  { id: "a9", role: "assistant", createdAt: 10, goalLoopTurn: turn(2), parts: [thinkingPart("a9"), toolPart("a9")] },
  { id: "a10", role: "assistant", createdAt: 11, goalLoopTurn: turn(2), parts: [textPart("a10", "ターン2も完了しました")] },
];

function timelineRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".task-message-row")];
}

function rowKind(row: HTMLElement): "log" | "message" {
  return row.querySelector("details[data-task-tool-group]") ? "log" : "message";
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", class extends EventTarget { close() {} });
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
  saveTaskSessionCache({ task, messages, isStreaming: false, isCompacting: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("task timeline invariants", () => {
  it("never renders two activity logs in a row", () => {
    render(<TaskView taskId={task.id} mdUp />);
    const kinds = timelineRows().map(rowKind);
    expect(kinds).toContain("log");
    expect(kinds.some((kind, index) => kind === "log" && kinds[index - 1] === "log")).toBe(false);
  });

  it("never renders a row that only shows a metadata header", () => {
    render(<TaskView taskId={task.id} mdUp />);
    const headerOnly = timelineRows().filter((row) => {
      if (row.querySelector("details[data-task-tool-group]")) return false;
      const body = row.textContent?.replace(row.querySelector('[aria-label="応答メタデータ"]')?.textContent ?? "", "");
      return !body?.trim();
    });
    expect(headerOnly).toHaveLength(0);
  });

  it("keeps short tool preambles inside the log and real replies outside", () => {
    render(<TaskView taskId={task.id} mdUp />);
    const log = document.querySelector<HTMLDetailsElement>("details[data-task-tool-group]")!;
    expect(log.textContent).toContain("次にテストを流します");
    const outside = timelineRows()
      .filter((row) => rowKind(row) === "message")
      .map((row) => row.textContent ?? "");
    expect(outside.some((text) => text.includes("ターン1を完了しました"))).toBe(true);
    expect(outside.some((text) => text.includes("結果を報告します。"))).toBe(true);
    expect(outside.some((text) => text.includes("次にテストを流します"))).toBe(false);
  });

  it("keeps one Goal Loop divider per turn that has visible output", () => {
    render(<TaskView taskId={task.id} mdUp />);
    const dividers = [...document.querySelectorAll('[role="separator"]')].map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(dividers).toEqual(["ループ 1", "ループ 2"]);
  });
});
