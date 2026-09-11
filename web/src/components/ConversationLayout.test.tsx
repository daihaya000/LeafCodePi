// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityLog, MessageBubble, MessageHeader } from "./ConversationLayout";
import { BotChatMessage } from "./bot/BotMessageList";
import { PartView } from "./task/PartView";

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
  expect([...botRow.classList].sort()).toEqual([...codeRow.classList].sort());
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
  expect(bot.querySelectorAll("summary .lucide-logs")).toHaveLength(1);
  expect(bot.querySelector("summary .lucide-logs")?.getAttribute("aria-hidden")).toBe("true");
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
