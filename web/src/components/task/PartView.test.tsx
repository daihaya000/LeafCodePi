// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessage } from "@/lib/types";
import { PartView } from "./PartView";

function bashMessage(output: string): UiMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        id: "tool-1",
        type: "tool",
        tool: "bash",
        callID: "call-1",
        state: {
          status: "running",
          input: { command: "npm test" },
          output,
          title: "bash",
        },
      },
    ],
  };
}

function logScroller(): HTMLDivElement {
  const pre = document.querySelector("pre");
  const scroller = pre?.parentElement?.parentElement;
  if (!(scroller instanceof HTMLDivElement)) throw new Error("ログスクロール領域が見つかりません");
  return scroller;
}

function setScrollMetrics(element: HTMLDivElement, scrollTop: number, scrollHeight: number) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
}

describe("PartView shell log", () => {
  afterEach(() => cleanup());

  it("uses a terminal-style dark surface for shell output", () => {
    render(<PartView message={bashMessage("line 1")} />);

    const pre = document.querySelector("pre");
    expect(pre?.className).toContain("text-terminal-text");
    expect(pre?.parentElement?.className).toContain("bg-terminal-bg");
  });

  it("follows new output until the user scrolls up, then resumes at the bottom", () => {
    const view = render(<PartView message={bashMessage("line 1")} />);
    const scroller = logScroller();

    setScrollMetrics(scroller, 0, 1000);
    view.rerender(<PartView message={bashMessage("line 1\nline 2")} />);
    expect(scroller.scrollTop).toBe(900);

    setScrollMetrics(scroller, 300, 1200);
    fireEvent.scroll(scroller);
    view.rerender(<PartView message={bashMessage("line 1\nline 2\nline 3")} />);
    expect(scroller.scrollTop).toBe(300);

    setScrollMetrics(scroller, 1100, 1200);
    fireEvent.scroll(scroller);
    setScrollMetrics(scroller, 1100, 1400);
    view.rerender(<PartView message={bashMessage("line 1\nline 2\nline 3\nline 4")} />);
    expect(scroller.scrollTop).toBe(1300);
  });
});

describe("PartView structured result", () => {
  afterEach(() => cleanup());

  it("renders Goal Loop result JSON as a readable card", () => {
    const message: UiMessage = {
      id: "assistant-result",
      role: "assistant",
      createdAt: 1,
      parts: [
        {
          id: "result-text",
          type: "text",
          text: JSON.stringify({
            status: "progress",
            summary: "テストを実行しました",
            next: "失敗箇所を確認します",
            evidence: "24件成功",
          }),
        },
      ],
    };

    render(<PartView message={message} />);

    expect(screen.getByRole("region", { name: "実行結果" })).toBeTruthy();
    expect(screen.getByText("テストを実行しました")).toBeTruthy();
    expect(screen.getByText("次のステップ")).toBeTruthy();
    expect(screen.queryByText(/"status"/)).toBeNull();
  });
});
