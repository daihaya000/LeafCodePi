// @vitest-environment happy-dom
import { useLayoutEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessage } from "@/lib/types";
import { ACTIVITY_USAGE_TITLES } from "@/components/ConversationLayout";
import { formatMessageTime } from "@/components/ui";
import { formatElapsed, MessageMetaHeader, PartView } from "./PartView";

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

  it("anchors the screen-reader status inside the tool header instead of extending the timeline scroll range", () => {
    render(<PartView message={bashMessage("line 1")} />);

    const status = screen.getByText("実行中", { selector: ".sr-only" });
    expect(status.closest("button")?.classList.contains("relative")).toBe(true);
  });

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
    expect(bubble.previousElementSibling?.querySelector("time")).not.toBeNull();
    expect(bubble.nextElementSibling?.tagName).toBe("BUTTON");
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
        agent="builder"
        accountLabel="仕事用"
      />,
    );

    expect(screen.queryByText("Code Bot")).toBeNull();
    const metadata = screen.getByLabelText("応答メタデータ");
    expect(metadata.className).toContain("w-full");
    expect(metadata.className).toContain("max-w-full");
    expect(metadata.parentElement?.className).toContain("max-w-bubble");
    for (const label of ["GPT", "builder", "仕事用"]) expect(metadata.textContent).toContain(label);
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
        agent="builder"
        accountLabel="仕事用"
      />,
    );

    expect(screen.getByText("max")).toBeTruthy();
    expect(screen.getByText("builder")).toBeTruthy();
    expect(screen.getByText("仕事用")).toBeTruthy();
    expect(screen.getByText("builder").querySelector('[data-agent-icon="builder"]')).not.toBeNull();
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

  it("places model, effort, optional account and time above token usage", () => {
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
        agent="builder"
        accountLabel="long-account@example.com"
      />,
    );

    const meta = screen.getByLabelText("応答メタデータ");
    const identity = screen.getByLabelText("モデル情報");
    const usage = screen.getByLabelText("トークン情報");
    const account = screen.getByText("long-account@example.com");
    const time = screen.getByText(formatMessageTime(1));
    expect(meta.children).toHaveLength(2);
    expect(meta.children[0]).toBe(identity);
    expect(meta.children[1]).toBe(usage);
    for (const label of ["gpt", "low", "builder", "long-account@example.com"]) {
      expect(identity.contains(screen.getByText(label))).toBe(true);
    }
    expect(account.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const label of ["32 tok", "22 tok/s", "3s"]) {
      const element = screen.getByText(label);
      expect(usage.contains(element)).toBe(true);
      expect(element.className).not.toContain("hidden");
    }
    const accountGroup = account.parentElement!;
    expect(accountGroup.className).toContain("hidden");
    expect(accountGroup.className).toContain("sm:inline-flex");
    expect(accountGroup.className).toContain("overflow-hidden");
    expect(accountGroup.getAttribute("title")).toBe("long-account@example.com");
    expect(accountGroup.querySelector('[aria-hidden="true"]')?.textContent).toBe("·");
    expect(identity.className).toContain("flex-wrap");
    expect(meta.className).not.toContain("overflow-hidden");
  });

  it("wraps long model labels on narrow rows without truncating the model or timestamp", () => {
    const createdAt = 1_758_947_460_000;
    const modelLabel = "provider/very-long-model-name-that-must-wrap";
    render(
      <MessageMetaHeader
        message={{ id: "assistant-meta", role: "assistant", createdAt, parts: [] }}
        modelLabel={modelLabel}
        effort="max"
        usage={{ outputTokens: 94_000, avgRate: 140, elapsedMs: 7_440_000 }}
      />,
    );

    const meta = screen.getByLabelText("応答メタデータ");
    const model = screen.getByText(modelLabel);
    const time = screen.getByText(formatMessageTime(createdAt));
    expect(screen.getByLabelText("モデル情報").className).toContain("flex-wrap");
    expect(screen.getByLabelText("トークン情報").textContent).toContain("94k tok");
    expect(meta.className).toContain("flex-col");
    expect(model.className).toContain("[overflow-wrap:anywhere]");
    expect(model.className).not.toContain("truncate");
    expect(time.className).toContain("shrink-0");
  });

  it("hides only the default agent field when it is the sole choice", () => {
    const message: UiMessage = { id: "assistant-meta", role: "assistant", createdAt: 1, parts: [] };
    const view = render(
      <MessageMetaHeader
        message={message}
        modelLabel="Model A"
        effort="max"
        agent="default"
        hideDefaultAgent
        accountLabel="Account A"
      />,
    );
    const meta = screen.getByLabelText("応答メタデータ");
    expect(screen.queryByText("default")).toBeNull();
    expect(meta.querySelector('[data-agent-icon="default"]')).toBeNull();
    expect(screen.getByText("Model A")).toBeTruthy();
    expect(screen.getByText("max")).toBeTruthy();
    expect(screen.getByText("Account A")).toBeTruthy();
    expect(screen.queryByLabelText("トークン情報")).toBeNull();

    view.rerender(<MessageMetaHeader message={message} agent="reviewer" hideDefaultAgent />);
    expect(screen.getByText("reviewer")).toBeTruthy();
    view.rerender(<MessageMetaHeader message={message} agent="default" />);
    expect(screen.getByText("default")).toBeTruthy();
  });

  it("shows the whole work log's usage instead of the first response's in a group header", () => {
    render(
      <MessageMetaHeader
        message={{
          id: "activity-header",
          role: "assistant",
          createdAt: 1,
          model: "gpt",
          outputTokens: 32,
          tokensPerSecond: 22,
          responseDurationMs: 3_000,
          parts: [],
        }}
        usage={{ outputTokens: 1_500, avgRate: 40, elapsedMs: 170_000 }}
      />,
    );

    expect(screen.queryByText("32 tok")).toBeNull();
    expect(screen.queryByText("22 tok/s")).toBeNull();
    expect(screen.queryByText("3s")).toBeNull();
    expect(screen.getByText("1.5k tok").getAttribute("title")).toBe(ACTIVITY_USAGE_TITLES.tokens);
    const rate = screen.getByText("40 tok/s");
    expect(rate.getAttribute("title")).toBe(ACTIVITY_USAGE_TITLES.rate);
    expect(rate.className).toContain("text-danger");
    expect(screen.getByText("2m 50s").getAttribute("title")).toBe(ACTIVITY_USAGE_TITLES.elapsed);
    // Group usage stays visible at narrow widths whenever there is room.
    for (const label of ["1.5k tok", "40 tok/s", "2m 50s"]) {
      expect(screen.getByText(label).className).not.toContain("hidden");
    }
    expect(screen.getByText("gpt")).toBeTruthy();
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

describe("PartView reasoning disclosure", () => {
  afterEach(() => cleanup());

  const thinkingMessage = (text: string, finished = false): UiMessage => ({
    id: "assistant-thinking",
    role: "assistant",
    createdAt: 1,
    parts: [
      { id: "thought", type: "thinking", text },
      ...(finished ? [{ id: "answer", type: "text" as const, text: "回答" }] : []),
    ],
  });

  it("opens while thinking and closes when the response or thinking part ends", () => {
    const view = render(<PartView message={thinkingMessage("考え中")} reasoningActive />);
    const toggle = screen.getByRole("button", { name: "思考" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    view.rerender(<PartView message={thinkingMessage("考え続けています")} reasoningActive />);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    view.rerender(<PartView message={thinkingMessage("考え続けています", true)} reasoningActive />);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    view.rerender(<PartView message={thinkingMessage("考え続けています")} reasoningActive />);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    view.rerender(<PartView message={thinkingMessage("考え続けています")} reasoningActive={false} />);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes a terminal failed thought even if the task is still marked working", () => {
    const view = render(<PartView message={thinkingMessage("考え中")} reasoningActive />);
    const toggle = screen.getByRole("button", { name: "思考" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    view.rerender(<PartView message={{ ...thinkingMessage("中断した思考"), error: "Aborted" }} reasoningActive />);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts collapsed for history and preserves manual toggles until the activity changes", () => {
    const view = render(<PartView message={thinkingMessage("短い思考")} />);
    const toggle = screen.getByRole("button", { name: "思考" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    view.rerender(<PartView message={thinkingMessage("短い思考に追記")} />);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("PartView memo", () => {
  it("updates the metadata when default-only visibility changes without changing the agent", () => {
    const message: UiMessage = { id: "assistant-default", role: "assistant", createdAt: 1, parts: [] };
    const view = render(<PartView message={message} agent="default" />);
    expect(screen.getByText("default")).toBeTruthy();

    view.rerender(<PartView message={message} agent="default" hideDefaultAgent />);
    expect(screen.queryByText("default")).toBeNull();
    view.rerender(<PartView message={message} agent="default" hideDefaultAgent={false} />);
    expect(screen.getByText("default")).toBeTruthy();
  });

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
      goalLoopTurn: { goalId: "goal-1", turn: 1, kind: "goal" },
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

  it("keeps the same JSON in normal turns instead of showing loop progress", () => {
    const message: UiMessage = {
      id: "assistant-normal-result",
      role: "assistant",
      createdAt: 1,
      parts: [
        {
          id: "normal-result-text",
          type: "text",
          text: `通常の回答です。\n\n\`\`\`json
${JSON.stringify({ status: "progress", summary: "通常ターンの結果" })}
\`\`\``,
        },
      ],
    };

    render(<PartView message={message} />);

    expect(screen.queryByRole("region", { name: "実行結果" })).toBeNull();
    expect(screen.getByText(/通常の回答です/)).toBeTruthy();
    expect(screen.getByText(/"status"/)).toBeTruthy();
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
