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
    });
  });
});
