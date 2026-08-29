// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGptAdvisoryPanel } from "./ChatGptAdvisoryPanel";

const { sendJson } = vi.hoisted(() => ({ sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ sendJson }));

describe("ChatGptAdvisoryPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    sendJson.mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path === "/api/chatgpt-bridge/message") {
        return Promise.resolve({
          ok: true,
          projectId: body.projectId,
          publicTaskId: body.publicTaskId,
          iteration: body.iteration,
          kind: body.kind,
          message: `[C2C]\nSTATE: ${String(body.kind).toUpperCase()}\nTASK_ID: ${body.publicTaskId}`,
        });
      }
      if (path === "/api/chatgpt-bridge/record") {
        return Promise.resolve({
          ok: true,
          projectId: body.projectId,
          publicTaskId: body.publicTaskId,
          iteration: body.iteration,
          changedFiles: 2,
          tests: body.tests ?? null,
          exitStatus: body.exitStatus,
        });
      }
      return Promise.resolve({ ok: true });
    });
  });

  afterEach(() => {
    cleanup();
    sendJson.mockReset();
  });

  it("generates a bounded INIT and keeps the external id separate", async () => {
    render(<ChatGptAdvisoryPanel taskId="internal-task" projectId="project-1" taskTitle="レビュー対象" />);
    fireEvent.click(screen.getByRole("button", { name: "INITを生成" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "ChatGPTへ貼り付けるメッセージ" })).toBeTruthy());
    const message = screen.getByRole("textbox", { name: "ChatGPTへ貼り付けるメッセージ" }) as HTMLTextAreaElement;
    expect(message.value).toContain("STATE: INIT");
    expect(message.value).not.toContain("internal-task");
    expect(message.value).toContain("TASK_ID: c2c_");
  });

  it("records execution metadata without sending command output", async () => {
    render(<ChatGptAdvisoryPanel taskId="internal-task" projectId="project-1" taskTitle="実装" />);
    fireEvent.change(screen.getByLabelText("テスト要約（任意）"), { target: { value: "80 passed" } });
    fireEvent.click(screen.getByRole("button", { name: "実行結果を記録" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/chatgpt-bridge/record",
      expect.objectContaining({ tests: "80 passed", exitStatus: "ok" }),
    ));
    expect(sendJson.mock.calls[0]?.[1]).not.toHaveProperty("command");
  });

  it("imports PLAN as an explicitly guarded normal task prompt", async () => {
    render(<ChatGptAdvisoryPanel taskId="internal-task" projectId="project-1" taskTitle="実装" />);
    const input = screen.getByRole("textbox", { name: "ChatGPTの外部提案" });
    fireEvent.change(input, { target: { value: "ファイルを確認してください" } });
    fireEvent.click(screen.getByRole("button", { name: "未検証の提案としてPiへ送信" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/tasks/internal-task/prompt",
      expect.objectContaining({
        prompt: expect.stringContaining("未検証の提案"),
      }),
    ));
    expect(sendJson.mock.calls.find(([path]) => path === "/api/tasks/internal-task/prompt")?.[1].prompt).toContain("ファイルを確認してください");
  });
});
