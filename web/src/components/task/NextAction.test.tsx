// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextAction } from "./NextAction";

const sendJson = vi.hoisted(() => vi.fn());

vi.mock("@/lib/client", () => ({ sendJson }));

afterEach(() => {
  cleanup();
  sendJson.mockReset();
});

describe("NextAction", () => {
  beforeEach(() => {
    sendJson.mockResolvedValue({ suggestion: "テストを実行する" });
  });

  it("sends the selected account with a separate-account model", async () => {
    render(
      <NextAction
        taskId="task-1"
        sessionId="session-1"
        model={{
          providerID: "anthropic",
          modelID: "claude-sonnet",
          accountId: "acc-1",
        }}
        onApply={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/tasks/task-1/next-action",
        {
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet",
            accountId: "acc-1",
          },
        },
      );
      expect(screen.getByRole("dialog", { name: "次の指示の提案" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "提案を閉じる" }));
    expect(screen.queryByRole("dialog", { name: "次の指示の提案" })).toBeNull();
    expect(screen.getByRole("button", { name: "提案を表示" })).toBeTruthy();
  });

  it("closes after applying a suggestion when the callback accepts it", async () => {
    const onApply = vi.fn(() => true);
    render(
      <NextAction
        taskId="task-1"
        sessionId="session-1"
        onApply={onApply}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "次の指示の提案" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "入力欄に反映" }));
    expect(onApply).toHaveBeenCalledWith("テストを実行する");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "次の指示の提案" })).toBeNull());
  });

  it("keeps the suggestion open when applying is rejected", async () => {
    const onApply = vi.fn(() => false);
    render(
      <NextAction
        taskId="task-1"
        sessionId="session-1"
        onApply={onApply}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "次の指示の提案" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "入力欄に反映" }));
    expect(onApply).toHaveBeenCalledWith("テストを実行する");
    expect(screen.getByRole("dialog", { name: "次の指示の提案" })).toBeTruthy();
  });
});
