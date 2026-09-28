// @vitest-environment happy-dom
import { useRef, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_PROGRESS_CLIENT_TIMEOUT_MS } from "@/lib/task-progress";
import { TaskProgressAsk } from "./TaskProgressAsk";

const sendJson = vi.hoisted(() => vi.fn());

vi.mock("@/lib/client", () => ({ sendJson }));

const requestOptions = expect.objectContaining({
  timeoutMs: TASK_PROGRESS_CLIENT_TIMEOUT_MS,
  signal: expect.any(AbortSignal),
});

function InlineProgressAsk(props: Omit<ComponentProps<typeof TaskProgressAsk>, "panelRef">) {
  const panelRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={panelRef} data-testid="above-composer" />
      <div data-testid="composer"><TaskProgressAsk {...props} panelRef={panelRef} /></div>
    </>
  );
}

function answer(text: string, question = "現在の進捗を要約してください。") {
  return {
    answer: text,
    question,
    model: { providerID: "anthropic", modelID: "claude-haiku" },
    source: "direct",
    snapshotAt: new Date(2026, 8, 28, 14, 5, 0).getTime(),
    working: true,
  };
}

afterEach(() => {
  cleanup();
  sendJson.mockReset();
});

describe("TaskProgressAsk", () => {
  beforeEach(() => {
    sendJson.mockResolvedValue(answer("- 作業中: テストを実行"));
  });

  it("asks for a summary and shows the answer above the composer", async () => {
    render(
      <InlineProgressAsk
        taskId="task-1"
        sessionId="session-1"
        model={{ providerID: "anthropic", modelID: "claude-sonnet", accountId: "acc-1" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "進捗を確認" }));

    expect(await screen.findByText("作業中: テストを実行")).toBeTruthy();
    expect(sendJson).toHaveBeenCalledWith(
      "/api/tasks/task-1/progress",
      { model: { providerID: "anthropic", modelID: "claude-sonnet", accountId: "acc-1" } },
      "POST",
      requestOptions,
    );
    const panel = screen.getByRole("region", { name: "進捗の確認" });
    expect(screen.getByTestId("above-composer").contains(panel)).toBe(true);
    expect(screen.getByTestId("composer").contains(panel)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panel.textContent).toContain("14:05 時点（実行中）");
    expect(panel.textContent).toContain("生成モデル: claude-haiku");
    expect(panel.textContent).toContain("エージェントには送信されず");

    fireEvent.click(screen.getByRole("button", { name: "進捗の確認を閉じる" }));
    expect(screen.queryByRole("region", { name: "進捗の確認" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "進捗の確認を表示" }));
    expect(screen.getByText("作業中: テストを実行")).toBeTruthy();
    expect(sendJson).toHaveBeenCalledTimes(1);
  });

  it("sends a typed question on Enter but not while the IME is composing", async () => {
    sendJson
      .mockResolvedValueOnce(answer("要約"))
      .mockResolvedValueOnce(answer("まだ実行中です", "テストは通った？"));
    render(<InlineProgressAsk taskId="task-1" sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: "進捗を確認" }));
    await screen.findByText("要約");
    const input = screen.getByRole("textbox", { name: "進捗についての質問" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "テストは通った？" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(sendJson).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("まだ実行中です")).toBeTruthy();
    expect(sendJson).toHaveBeenNthCalledWith(
      2,
      "/api/tasks/task-1/progress",
      { question: "テストは通った？" },
      "POST",
      requestOptions,
    );
    expect(screen.getByText("質問: テストは通った？")).toBeTruthy();
    expect(input.value).toBe("");
  });

  it("shows the error and retries the same question", async () => {
    sendJson
      .mockRejectedValueOnce(new Error("生成モデルが設定されていません"))
      .mockResolvedValueOnce(answer("再試行の回答"));
    render(<InlineProgressAsk taskId="task-1" sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: "進捗を確認" }));
    expect((await screen.findByRole("alert")).textContent).toBe("生成モデルが設定されていません");

    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText("再試行の回答")).toBeTruthy();
    expect(sendJson).toHaveBeenNthCalledWith(2, "/api/tasks/task-1/progress", {}, "POST", requestOptions);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the answer when the task changes", async () => {
    const view = render(<InlineProgressAsk taskId="task-1" sessionId="session-1" />);
    fireEvent.click(screen.getByRole("button", { name: "進捗を確認" }));
    await screen.findByText("作業中: テストを実行");

    view.rerender(<InlineProgressAsk taskId="task-2" sessionId="session-2" />);

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "進捗の確認" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "進捗を確認" })).toBeTruthy();
  });

  it("marks the answer stale after the work moves on and re-asks from the trigger", async () => {
    sendJson.mockResolvedValueOnce(answer("最初の回答")).mockResolvedValueOnce(answer("最新の回答"));
    const view = render(<InlineProgressAsk taskId="task-1" sessionId="session-1" revision="r1" />);

    fireEvent.click(screen.getByRole("button", { name: "進捗を確認" }));
    await screen.findByText("最初の回答");
    expect(screen.getByRole("region", { name: "進捗の確認" }).textContent).not.toContain("その後に作業が進んでいます");

    view.rerender(<InlineProgressAsk taskId="task-1" sessionId="session-1" revision="r2" />);
    expect(screen.getByRole("region", { name: "進捗の確認" }).textContent).toContain("その後に作業が進んでいます");

    fireEvent.click(screen.getByRole("button", { name: "進捗の確認を閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "進捗を確認" }));

    expect(await screen.findByText("最新の回答")).toBeTruthy();
    expect(sendJson).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("region", { name: "進捗の確認" }).textContent).not.toContain("その後に作業が進んでいます");
  });

  it("cancels the in-flight request when the view unmounts", async () => {
    let signal: AbortSignal | undefined;
    sendJson.mockImplementation(
      (_path: string, _body: unknown, _method: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => {});
      },
    );
    const view = render(<InlineProgressAsk taskId="task-1" sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: "進捗を確認" }));
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);

    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
