// @vitest-environment happy-dom
import { useRef, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextAction } from "./NextAction";

const sendJson = vi.hoisted(() => vi.fn());

vi.mock("@/lib/client", () => ({ sendJson }));

function InlineNextAction(props: Omit<ComponentProps<typeof NextAction>, "panelRef">) {
  const panelRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={panelRef} data-testid="above-composer" />
      <div data-testid="composer"><NextAction {...props} panelRef={panelRef} /></div>
    </>
  );
}

afterEach(() => {
  cleanup();
  sendJson.mockReset();
});

describe("NextAction", () => {
  beforeEach(() => {
    sendJson.mockResolvedValue({ suggestion: "テストを実行する" });
  });

  it("shows suggestions above the composer instead of in a dialog", async () => {
    render(
      <InlineNextAction
        taskId="task-1"
        sessionId="session-1"
        model={{ providerID: "anthropic", modelID: "claude-sonnet", accountId: "acc-1" }}
        onApply={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/tasks/task-1/next-action", {
        model: { providerID: "anthropic", modelID: "claude-sonnet", accountId: "acc-1" },
      });
      const panel = screen.getByRole("region", { name: "次の指示の提案" });
      expect(screen.getByTestId("above-composer").contains(panel)).toBe(true);
      expect(screen.getByTestId("composer").contains(panel)).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect((await screen.findByRole("button", { name: "提案を表示" })).textContent).toBe("提案");

    fireEvent.click(screen.getByRole("button", { name: "提案を閉じる" }));
    expect(screen.queryByRole("region", { name: "次の指示の提案" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "提案を表示" }));
    fireEvent.click(screen.getByRole("button", { name: "提案を表示" }));
    expect(screen.getByRole("button", { name: "提案を表示" }).textContent).toBe("提案");
    expect(screen.getByRole("region", { name: "次の指示の提案" })).toBeTruthy();
    expect(sendJson).toHaveBeenCalledTimes(1);
  });

  it("closes after applying a suggestion when the callback accepts it", async () => {
    const onApply = vi.fn(() => true);
    render(<InlineNextAction taskId="task-1" sessionId="session-1" onApply={onApply} />);

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));
    await screen.findByRole("region", { name: "次の指示の提案" });
    await screen.findByRole("button", { name: "入力欄に反映" });

    fireEvent.click(screen.getByRole("button", { name: "入力欄に反映" }));
    expect(onApply).toHaveBeenCalledWith("テストを実行する");
    expect(screen.queryByRole("region", { name: "次の指示の提案" })).toBeNull();
  });

  it("keeps the suggestion open when applying is rejected", async () => {
    const onApply = vi.fn(() => false);
    render(<InlineNextAction taskId="task-1" sessionId="session-1" onApply={onApply} />);

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));
    await screen.findByRole("button", { name: "入力欄に反映" });

    fireEvent.click(screen.getByRole("button", { name: "入力欄に反映" }));
    expect(onApply).toHaveBeenCalledWith("テストを実行する");
    expect(screen.getByRole("region", { name: "次の指示の提案" })).toBeTruthy();
  });

  it("keeps the panel open when requesting another suggestion", async () => {
    sendJson.mockResolvedValueOnce({ suggestion: "テストを実行する" })
      .mockResolvedValueOnce({ suggestion: "型チェックを実行する" });
    render(<InlineNextAction taskId="task-1" sessionId="session-1" onApply={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));
    await screen.findByText("テストを実行する");
    fireEvent.click(screen.getByRole("button", { name: "別の提案" }));

    expect(await screen.findByText("型チェックを実行する")).toBeTruthy();
    expect(sendJson).toHaveBeenNthCalledWith(2, "/api/tasks/task-1/next-action", {
      previousSuggestions: ["テストを実行する"],
    });
    expect(screen.getByTestId("above-composer").contains(screen.getByRole("region", { name: "次の指示の提案" }))).toBe(true);
  });

  it("clears an open suggestion when the conversation changes", async () => {
    const view = render(<InlineNextAction taskId="task-1" sessionId="session-1" invalidateKey="before" onApply={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));
    await screen.findByText("テストを実行する");

    view.rerender(<InlineNextAction taskId="task-1" sessionId="session-1" invalidateKey="after" onApply={() => {}} />);
    expect(await screen.findByText("会話が更新されたため、提案を破棄しました。")).toBeTruthy();
    expect(screen.queryByText("テストを実行する")).toBeNull();
    expect(screen.getByRole("button", { name: "次の指示を提案" })).toBeTruthy();
  });
});
