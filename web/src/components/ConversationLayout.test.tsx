// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UiMessage } from "@/lib/types";
import { ActivityLog, MessageBubble, MessageHeader } from "./ConversationLayout";
import { BotChatMessage } from "./bot/BotMessageList";
import { PartView } from "./task/PartView";

/**
 * 描画スキップ用の perf クラスは形状ではない。Bot は行そのもの（BotMessageRow）、
 * Code は TaskView の外側行（.task-message-row）が持つため、形状の比較からは除外し、
 * 行側では別途存在を確認する。
 */
const PERF_CLASSES = ["[content-visibility:auto]", "[contain-intrinsic-size:auto_8rem]"];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setScrollMetrics(element: HTMLElement, scrollTop: number, scrollHeight: number) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
}

it.each([true, false])("keeps Bot and Code bubble/header geometry identical (user: %s)", (user) => {
  const { container } = render(<>
    <section data-view="bot"><BotChatMessage user={user} createdAt={1} sender={{ name: "Bot" }} text="Short reply" /></section>
    <section data-view="code"><PartView message={{ id: "message", role: user ? "user" : "assistant", createdAt: 1, parts: [{ id: "text", type: "text", text: "Short reply" }] }} /></section>
  </>);
  const botRow = container.querySelector('[data-view="bot"] > div')!;
  const codeRow = container.querySelector('[data-view="code"] > article')!;
  expect([...botRow.classList].filter((name) => !PERF_CLASSES.includes(name)).sort()).toEqual([...codeRow.classList].sort());
  expect(PERF_CLASSES.every((name) => botRow.classList.contains(name))).toBe(true);
  const bot = container.querySelector(".bot-message-bubble")!;
  const code = container.querySelector('[data-view="code"] .rounded-3xl')!;
  expect([...bot.classList].filter((name) => name !== "bot-message-bubble").sort()).toEqual([...code.classList].sort());
  expect(bot.classList.contains("w-full")).toBe(!user);
  expect(bot.classList.contains("max-w-bubble")).toBe(true);
  expect(bot.classList.contains("self-end")).toBe(user);
  if (!user) expect(bot.previousElementSibling?.className).toBe(code.previousElementSibling?.className);
});

it("uses identical closed, scroll-bounded logs with full-width nested cards and headers", () => {
  const parts = [{ id: "tool", type: "tool" as const, tool: "read", callID: "call", state: { status: "completed" as const, input: {}, startedAtMs: 1000, endedAtMs: 3000 } }];
  const { container } = render(<>{(["bot", "task"] as const).map((kind) => <ActivityLog key={kind} kind={kind} count={1} parts={parts} active={false}>
    <MessageHeader>Metadata</MessageHeader><MessageBubble>Tool content</MessageBubble>
  </ActivityLog>)}</>);
  const [bot, task] = [...container.querySelectorAll("details")];
  expect(bot.className).toBe(task.className);
  expect(bot.querySelector("summary")?.outerHTML).toBe(task.querySelector("summary")?.outerHTML);
  expect(bot.querySelectorAll("summary .lucide-scroll-text")).toHaveLength(1);
  expect(bot.querySelector("summary .lucide-scroll-text")?.getAttribute("aria-hidden")).toBe("true");
  expect(bot.querySelector("summary .lucide-chevron-right")).not.toBeNull();
  expect(bot.open).toBe(false);
  expect(bot.querySelector("summary")?.textContent).toBe("作業ログ1件 · 2s");
  const content = bot.querySelector("summary")!.nextElementSibling!;
  expect(content.classList.contains("[&_.max-w-bubble]:max-w-full")).toBe(true);
  expect(content.classList.contains("overflow-y-auto")).toBe(true);
  expect(content.classList.contains("max-h-[min(28rem,50dvh)]")).toBe(true);
  fireEvent.click(bot.querySelector("summary")!);
  expect(bot.open).toBe(true);
  expect(task.open).toBe(false);
});

it("summarizes the log's total output tokens, average tok/s, and elapsed time", () => {
  const parts = [{ id: "tool", type: "tool" as const, tool: "read", callID: "call", state: { status: "completed" as const, input: {}, startedAtMs: 3_000, endedAtMs: 4_000 } }];
  const messages: UiMessage[] = [
    { id: "a", role: "assistant", createdAt: 1_000, responseDurationMs: 1_500, outputTokens: 1_200, tokensPerSecond: 30, parts: [] },
    { id: "b", role: "assistant", createdAt: 4_500, responseDurationMs: 2_500, outputTokens: 300, tokensPerSecond: 50, parts: [] },
    // 使用量も所要時間も無い応答は集計を変えない。
    { id: "c", role: "assistant", createdAt: 60_000, tokensPerSecond: 0, parts: [] },
  ];
  const { container } = render(<ActivityLog kind="task" count={2} parts={parts} messages={messages} active={false}>
    <MessageBubble>Tool content</MessageBubble>
  </ActivityLog>);
  const summary = container.querySelector("summary")!;
  // 最初の生成開始(1.0s)から最後の生成終了(7.0s)まで。平均は (30 + 50) / 2。
  expect(summary.textContent).toBe("作業ログ2件 · 1.5k tok · 40 tok/s · 6s");
  expect(summary.querySelector('[title^="作業ログ内の平均"]')?.className).toContain("text-danger");
});

it("keeps the activity header both above and inside the collapsible log", () => {
  const { container } = render(
    <ActivityLog
      kind="task"
      header={<MessageHeader>Frame metadata</MessageHeader>}
      count={1}
      parts={[]}
      active={false}
    >
      <MessageBubble>Tool content</MessageBubble>
    </ActivityLog>,
  );
  const log = container.querySelector("details")!;
  const content = log.querySelector("summary")!.nextElementSibling!;
  expect(log.previousElementSibling?.textContent).toBe("Frame metadata");
  expect(content.textContent).toContain("Frame metadata");
  expect(log.parentElement?.className).toContain("space-y-2");
  expect(log.parentElement?.className).not.toContain("max-w-bubble");
  expect(log.className).toContain("max-w-bubble");
});

it("follows the newest activity while expanded until the user scrolls up", () => {
  const grow: (() => void)[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { grow.push(callback); }
    observe() {}
    disconnect() {}
  });
  const { container } = render(<ActivityLog kind="task" count={1} parts={[]} active>
    <MessageBubble>Tool content</MessageBubble>
  </ActivityLog>);
  const log = container.querySelector("details")!;
  const scroller = log.querySelector("summary")!.nextElementSibling as HTMLElement;

  setScrollMetrics(scroller, 0, 1000);
  fireEvent.click(log.querySelector("summary")!);
  expect(scroller.scrollTop).toBe(800);

  setScrollMetrics(scroller, 100, 1000);
  fireEvent.scroll(scroller);
  setScrollMetrics(scroller, 100, 1400);
  grow.forEach((callback) => callback());
  expect(scroller.scrollTop).toBe(100);

  setScrollMetrics(scroller, 1200, 1400);
  fireEvent.scroll(scroller);
  setScrollMetrics(scroller, 1200, 1600);
  grow.forEach((callback) => callback());
  expect(scroller.scrollTop).toBe(1400);
});
