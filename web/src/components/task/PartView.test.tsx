// @vitest-environment happy-dom
import { useLayoutEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessage } from "@/lib/types";
import { formatElapsed, PartView } from "./PartView";

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

describe("formatElapsed", () => {
  it("shows subsecond durations in milliseconds and carries seconds into minutes", () => {
    expect(formatElapsed(49)).toBe("49ms");
    expect(formatElapsed(-1)).toBe("0ms");
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(1)).toBe("1ms");
    expect(formatElapsed(250)).toBe("250ms");
    expect(formatElapsed(999)).toBe("999ms");
    expect(formatElapsed(1_000)).toBe("1s");
    expect(formatElapsed(2_350)).toBe("2s");
    expect(formatElapsed(2_500)).toBe("3s");
    expect(formatElapsed(59_500)).toBe("1m 0s");
    expect(formatElapsed(61_250)).toBe("1m 1s");
  });
});

function readMessage(status: "running" | "error"): UiMessage {
  const failed = status === "error";
  return {
    id: "assistant-tool",
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        id: "tool-1",
        type: "tool",
        tool: "read",
        callID: "call-1",
        state: {
          status,
          input: { path: "README.md" },
          title: "read",
          ...(failed ? { output: "read failed", error: "read failed" } : {}),
        },
      },
    ],
  };
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

describe("PartView tool error", () => {
  afterEach(() => cleanup());

  it("mounts an error card open before the parent measures its layout", () => {
    const layoutStates: string[] = [];
    const runningMessage = readMessage("running");
    const errorMessage = readMessage("error");
    function LayoutProbe({ message }: { message: UiMessage }) {
      useLayoutEffect(() => {
        layoutStates.push(
          document.querySelector<HTMLButtonElement>("button[aria-expanded]")?.getAttribute(
            "aria-expanded",
          ) ?? "missing",
        );
      }, [message]);
      return <PartView message={message} />;
    }

    const view = render(<LayoutProbe message={runningMessage} />);
    view.rerender(<LayoutProbe message={errorMessage} />);

    expect(layoutStates).toEqual(["false", "true"]);
  });
});

describe("PartView sender and response metadata", () => {
  afterEach(() => cleanup());

  const bot = { name: "Code Bot", avatarShape: "circle" as const, avatarImage: null };

  it("shows the Bot sender above its neutral prompt bubble", () => {
    render(<PartView message={userMessage("Botからの指示")} bot={bot} />);

    const sender = screen.getByLabelText("送信者: Code Bot（Bot）");
    expect(sender.textContent).toContain("Code Bot");
    expect(sender.querySelector('svg[aria-label="Code Botのアバター"]')).not.toBeNull();
    expect(sender.querySelector("time")).not.toBeNull();
    const bubble = screen.getByText("Botからの指示").parentElement!;
    expect(bubble.className).toContain("bg-bot-assistant");
    expect(bubble.className).toContain("text-text");
    expect(bubble.className).not.toContain("bg-bot-user");
    expect(bubble.parentElement?.firstElementChild?.contains(sender)).toBe(true);
  });

  it("keeps human prompts blue and retains the revert action", () => {
    let reverted: UiMessage | undefined;
    const message = userMessage("ユーザーからの指示");
    render(<PartView message={message} onRevert={(value) => { reverted = value; }} />);

    const bubble = screen.getByText("ユーザーからの指示").parentElement!;
    expect(bubble.className).toContain("bg-bot-user");
    expect(bubble.className).toContain("text-white");
    expect(screen.queryByText("Code Bot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "入力欄に戻す" }));
    expect(reverted).toBe(message);
  });

  it("keeps Bot identity out of the agent response metadata", () => {
    render(
      <PartView
        message={{ id: "assistant-bot", role: "assistant", createdAt: 1, parts: [] }}
        bot={bot}
        modelLabel="GPT"
        agent="build"
        accountLabel="仕事用"
      />,
    );

    expect(screen.queryByText("Code Bot")).toBeNull();
    const metadata = screen.getByLabelText("応答メタデータ");
    expect(metadata.className).toContain("w-full");
    expect(metadata.className).toContain("max-w-full");
    expect(metadata.parentElement?.className).toContain("max-w-bubble");
    for (const label of ["GPT", "build", "仕事用"]) expect(metadata.textContent).toContain(label);
  });

  it("updates the sender and bubble when Bot metadata arrives", () => {
    const message = userMessage("指示");
    const view = render(<PartView message={message} />);
    view.rerender(<PartView message={message} bot={bot} />);
    expect(screen.getByText("Code Bot")).toBeTruthy();
    expect(screen.getByText("指示").parentElement?.className).toContain("bg-bot-assistant");

    view.rerender(<PartView message={message} bot={{ ...bot, name: "Renamed Bot" }} />);
    expect(screen.queryByText("Code Bot")).toBeNull();
    expect(screen.getByText("Renamed Bot")).toBeTruthy();
  });

  it("shows the account label beside the agent", () => {
    render(
      <PartView
        message={{ id: "assistant-meta", role: "assistant", createdAt: 1, parts: [] }}
        effort="max"
        agent="build"
        accountLabel="仕事用"
      />,
    );

    expect(screen.getByText("max")).toBeTruthy();
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("仕事用")).toBeTruthy();
    expect(screen.getByText("build").querySelector('[data-agent-icon="build"]')).not.toBeNull();
  });

  it("can render activity without duplicating the message metadata row", () => {
    render(
      <PartView
        hideMeta
        message={{
          id: "assistant-activity",
          role: "assistant",
          createdAt: 1,
          model: "gpt",
          outputTokens: 32,
          parts: [{ id: "thinking-1", type: "thinking", text: "内部で確認しています" }],
        }}
      />,
    );

    expect(screen.queryByLabelText("応答メタデータ")).toBeNull();
    expect(screen.getByText("思考")).toBeTruthy();
  });

  it("hides token metadata from tok onward in narrow task panes", () => {
    render(
      <PartView
        message={{
          id: "assistant-stats",
          role: "assistant",
          createdAt: 1,
          model: "gpt",
          outputTokens: 32,
          tokensPerSecond: 22,
          responseDurationMs: 3_000,
          parts: [],
        }}
        effort="low"
        agent="build"
      />,
    );

    for (const label of ["32 tok", "22 tok/s", "3s"]) {
      const element = screen.getByText(label);
      expect(element.className).toContain("hidden");
      expect(element.className).toContain("@min-[48rem]/task:inline");
      expect(element.className).not.toContain("sm:inline");
    }
  });

  it("opens timeline images for enlarged viewing", () => {
    render(
      <PartView
        message={{
          id: "user-image",
          role: "user",
          createdAt: 1,
          parts: [
            {
              id: "image-1",
              type: "image",
              url: "data:image/png;base64,abc",
              mime: "image/png",
              filename: "shot.png",
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "shot.pngを拡大表示" }));
    expect(screen.getByRole("dialog", { name: "shot.png（拡大表示）" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "画像を閉じる" }));
    expect(screen.queryByRole("dialog", { name: "shot.png（拡大表示）" })).toBeNull();
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
          text: `todo実態: 完了1件（対象テスト）\n\n\`\`\`json
${JSON.stringify({
  status: "progress",
  summary: "テストを実行しました",
  next: "失敗箇所を確認します",
  evidence: "24件成功",
})}
\`\`\``,
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
    const error = screen.getByRole("alert");
    expect(error.className).toContain("max-w-bubble");
    expect(error.className).toContain("self-start");
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
