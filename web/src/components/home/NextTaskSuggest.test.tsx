// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextTaskSuggest } from "./NextTaskSuggest";

const sendJson = vi.hoisted(() => vi.fn());

vi.mock("@/lib/client", () => ({ sendJson }));

afterEach(() => {
  cleanup();
  sendJson.mockReset();
});

describe("NextTaskSuggest", () => {
  beforeEach(() => {
    sendJson.mockResolvedValue({ suggestion: "次のタスクを整理する" });
  });

  it("sends the selected account with a separate-account model", async () => {
    render(
      <NextTaskSuggest
        projectId="project-1"
        model={{
          providerID: "anthropic",
          modelID: "claude-sonnet",
          accountId: "acc-1",
        }}
        onApply={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次のタスクを提案" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/projects/project-1/next-task",
        {
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet",
            accountId: "acc-1",
          },
        },
        "POST",
        { timeoutMs: 180_000 },
      );
    });
  });
});
