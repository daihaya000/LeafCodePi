// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import { saveForkDraft } from "@/lib/task-fork";
import type { TaskSummary, UiMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), apiUrl: (path: string) => path }));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/ProjectExplorerButton", () => ({ ProjectExplorerButton: () => null }));
import { TaskView } from "./TaskView";

const source: TaskSummary = {
  id: "fork-source", projectId: null, projectName: "test", title: "source", directory: "",
  isolation: "current_folder", status: "idle", sessionId: "session-source", sessionFile: "source.jsonl",
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};
const forked: TaskSummary = { ...source, id: "fork-destination", title: "source（分岐）", sessionId: "session-fork", sessionFile: "fork.jsonl" };
const history: UiMessage[] = [
  { id: "ancestor", role: "user", createdAt: 1, parts: [{ id: "ancestor-text", type: "text", text: "前の発言" }] },
  { id: "reply", role: "assistant", createdAt: 2, parts: [{ id: "reply-text", type: "text", text: "前の応答" }] },
];
let streams: EventTarget[];

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); streams = [];
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
  mocks.sendJson.mockResolvedValue({});
  vi.stubGlobal("EventSource", class extends EventTarget {
    constructor() { super(); streams.push(this); }
    close() {}
  });
  saveTaskSessionCache({ task: source, messages: history, isStreaming: false, isCompacting: false });
  saveTaskSessionCache({ task: forked, messages: history, isStreaming: false, isCompacting: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

async function ready(task: TaskSummary) {
  await act(async () => {
    streams.at(-1)!.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ eventType: "ready", task, messages: history, isStreaming: false, isCompacting: false }) }));
  });
}

describe("TaskView fork draft integration", () => {
  it("restores the unsent draft and attachments after the same pane switches tasks, including StrictMode", async () => {
    const view = render(<StrictMode><TaskView taskId={source.id} mdUp /></StrictMode>);
    await ready(source);
    fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "元タスクの入力" } });
    saveForkDraft(forked.id, {
      text: "選んだ発言", images: [{ uri: "data:image/png;base64,YQ==", mime: "image/png", name: "分岐画像.png" }],
      files: [{ uri: "data:text/plain;base64,YQ==", mime: "text/plain", name: "分岐資料.txt" }],
    });
    view.rerender(<StrictMode><TaskView taskId={forked.id} mdUp /></StrictMode>);
    await ready(forked);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "フォローアップ" });
    expect(input.value).toBe("選んだ発言");
    expect(screen.getByText("分岐資料.txt")).toBeTruthy();
    expect(screen.getByRole("img", { name: "分岐画像.png" })).toBeTruthy();
    expect(mocks.sendJson.mock.calls.filter(([path]) => String(path).endsWith("/prompt"))).toHaveLength(0);
    fireEvent.change(input, { target: { value: "別パターンへ変更" } });
    await ready(forked);
    expect(input.value).toBe("別パターンへ変更");
    expect(mocks.sendJson.mock.calls.filter(([path]) => String(path).endsWith("/prompt"))).toHaveLength(0);
    expect(screen.getByText("前の応答")).toBeTruthy();
  });
});
