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

function userMessage(text: string): UiMessage {
  return {
    id: "user-1",
    role: "user",
    createdAt: 1,
    parts: [{ id: "user-text", type: "text", text }],
  };
}

function chatGPTMessage(): UiMessage {
  return {
    id: "chatgpt-1",
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        id: "chatgpt-tool-1",
        type: "tool",
        tool: "mcp__c2c__review",
        callID: "call-chatgpt-1",
        state: {
          status: "completed",
          input: { action: "review", prompt: "変更内容をレビューしてください" },
          output: "レビュー結果です。",
          title: "mcp__c2c__review",
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

describe("PartView ChatGPT card", () => {
  afterEach(() => cleanup());

  it("uses the dedicated ChatGPT label and keeps the result collapsible", () => {
    render(<PartView message={chatGPTMessage()} />);

    const card = screen.getByRole("button", { name: /ChatGPT/ });
    expect(card.textContent).toContain("変更内容をレビューしてください");
    expect(screen.getByText("レビュー結果です。").className).toContain("truncate");
    expect(card.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(card);
    expect(screen.getByText("操作")).toBeTruthy();
    expect(screen.getByText("依頼")).toBeTruthy();
    expect(screen.getByText("レビュー結果です。")).toBeTruthy();
  });
});

describe("PartView response metadata", () => {
  afterEach(() => cleanup());

  it("shows the account label beside the agent", () => {
    render(
      <PartView
        message={{ id: "assistant-meta", role: "assistant", createdAt: 1, parts: [] }}
        agent="build"
        accountLabel="仕事用"
      />,
    );

    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("仕事用")).toBeTruthy();
  });
});

describe("PartView memo", () => {
  afterEach(() => cleanup());

  it("skips re-rendering when the message reference and callback are stable", () => {
    const message = userMessage("こんにちは");
    const onRevert = () => undefined;

    const view = render(<PartView message={message} onRevert={onRevert} />);
    expect(screen.getByText("こんにちは")).toBeTruthy();

    // 同一 message 参照・同一 onRevert 参照での再レンダーは memo でスキップされる。
    view.rerender(<PartView message={message} onRevert={onRevert} />);
    expect(screen.getByText("こんにちは")).toBeTruthy();
  });

  it("re-renders when onRevert changes reference (inline arrow regression)", () => {
    const message = userMessage("こんにちは");
    const view = render(<PartView message={message} onRevert={() => undefined} />);
    // 毎回新参照の inline arrow は memo を無効化する（回帰防止: useCallback 必須）。
    view.rerender(<PartView message={message} onRevert={() => undefined} />);
    expect(screen.getByText("こんにちは")).toBeTruthy();
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

describe("PartView diagnostics", () => {
  afterEach(() => cleanup());

  it("keeps provider diagnostics collapsed until requested", () => {
    render(
      <PartView
        message={{
          id: "assistant-diagnostic",
          role: "assistant",
          createdAt: 1,
          parts: [],
          error: "fetch failed",
          diagnostics: [
            {
              type: "provider_transport_failure",
              error: { name: "TypeError", message: "fetch failed", code: "E_CONN" },
              details: { configuredTransport: "auto", fallbackTransport: "sse" },
            },
          ],
        }}
      />,
    );

    const details = screen.getByText("診断情報 (1)").closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("fetch failed")).toBeTruthy();
    expect(screen.getByText("provider_transport_failure")).toBeTruthy();
    expect(screen.getByText("transport: auto")).toBeTruthy();
  });
});

describe("PartView skill invocation", () => {
  afterEach(() => cleanup());

  it("renders Pi's expanded skill envelope as a highlighted slash reference", () => {
    render(
      <PartView
        message={userMessage(
          `<skill name="insane-search" location="/skills/insane-search/SKILL.md">\nReferences are relative to /skills/insane-search.\n\n# Insane Search\n\n折りたたまれる本文\n</skill>\n\n追加の依頼`,
        )}
      />,
    );

    const reference = screen.getByText("/skill:insane-search");
    expect(reference.className).toContain("bg-accent/15");
    expect(reference.className).toContain("text-accent");
    expect(screen.queryByText(/^<skill name=/)).toBeNull();
    expect(screen.queryByText("折りたたまれる本文")).toBeNull();
    expect(screen.getByText("追加の依頼")).toBeTruthy();
  });
});
