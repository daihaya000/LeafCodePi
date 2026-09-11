// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ActivityLog, MessageBubble, MessageHeader } from "./ConversationLayout";
import { BotChatMessage } from "./bot/BotMessageList";
import { PartView } from "./task/PartView";

afterEach(cleanup);

it.each([true, false])("keeps Bot and Code bubble/header geometry identical (user: %s)", (user) => {
  const { container } = render(<>
    <section data-view="bot"><BotChatMessage user={user} createdAt={1} sender={{ name: "Bot" }} text="Short reply" /></section>
    <section data-view="code"><PartView message={{ id: "message", role: user ? "user" : "assistant", createdAt: 1, parts: [{ id: "text", type: "text", text: "Short reply" }] }} /></section>
  </>);
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
