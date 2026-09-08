// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BotMessageError, BotMessageList, BotMessageMarkdown, BotMessageRow, BotMessageSender, BotMessageTime, BotResponseStatus } from "./BotMessageList";
import type { UiMessage } from "@/lib/types";

afterEach(cleanup);

it("follows loaded history and streaming, preserves reading position, and resets on conversation switch", () => {
  const { getByRole, rerender } = render(<BotMessageList conversationId="a">Loading</BotMessageList>);
  const viewport = getByRole("main");
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } });
  rerender(<BotMessageList conversationId="a">History</BotMessageList>);
  expect(viewport.scrollTop).toBe(1000);
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  rerender(<BotMessageList conversationId="a">New message</BotMessageList>);
  expect(viewport.scrollTop).toBe(100);
  rerender(<BotMessageList conversationId="b">Other history</BotMessageList>);
  expect(viewport.scrollTop).toBe(1000);
  viewport.scrollTop = 800;
  fireEvent.scroll(viewport);
  Object.defineProperty(viewport, "scrollHeight", { value: 1200 });
  rerender(<BotMessageList conversationId="b">Streaming</BotMessageList>);
  expect(viewport.scrollTop).toBe(1200);
});

it("places the time and footer below the bubble, for user and bot alike", () => {
  const createdAt = Date.UTC(2026, 8, 8, 2, 58);
  const { container, rerender } = render(<BotMessageRow user createdAt={createdAt} footer={<button type="button">入力欄に戻す</button>}>エージェントは？</BotMessageRow>);
  const row = container.firstElementChild!;
  expect(row.className).toContain("items-end");
  expect([...row.children].map((child) => child.tagName)).toEqual(["DIV", "TIME", "BUTTON"]);
  const bubble = row.children[0];
  expect(bubble.className).toContain("max-w-bubble");
  expect(bubble.className).toContain("bg-bot-user");

  rerender(<BotMessageRow user={false} createdAt={createdAt} header={<BotMessageSender name="MiMo" color="#0071E3" />}><BotMessageError text="応答に失敗しました" /></BotMessageRow>);
  const botRow = container.firstElementChild!;
  expect(botRow.className).toContain("items-start");
  expect(botRow.children[0].textContent).toBe("MiMo");
  expect(botRow.children[1].className).toContain("bg-bot-assistant");
  expect(botRow.querySelector("[role='alert']")?.textContent).toBe("応答に失敗しました");
});

it("renders bot Markdown with GFM", () => {
  const { container } = render(<BotMessageMarkdown text={"**bold**\n\n- item"} />);
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("ul li")?.textContent).toBe("item");
});

it("keeps the sender inline with prose without flattening lists", () => {
  const { container } = render(<BotMessageMarkdown text={"Hello\n\n- item\n\nAnother paragraph"} prefix={<span>Sender</span>} />);
  const markdown = container.firstElementChild!;
  expect(markdown.className).toContain("[&>p:first-of-type]:inline");
  expect(markdown.firstElementChild?.textContent).toBe("Sender");
  expect(markdown.querySelector("p")?.textContent).toBe("Hello");
  expect(markdown.querySelector("ul li")?.textContent).toBe("item");
  expect(markdown.querySelectorAll("p")).toHaveLength(2);
});

it("shows the animated bot and the current tool action while responding", () => {
  const messages: UiMessage[] = [{
    id: "assistant-1",
    role: "assistant",
    createdAt: Date.now(),
    parts: [{ id: "tool-1", type: "tool", tool: "read", callID: "call-1", state: { status: "running", input: { path: "README.md" } } }],
  }];
  const { container, getByRole } = render(<BotResponseStatus messages={messages} avatar={{ name: "Bot", color: "#0071E3" }} />);
  expect(getByRole("status").textContent).toContain("応答中…");
  expect(getByRole("status").textContent).toContain("読取");
  expect(container.querySelector(".bot-avatar-working")).toBeTruthy();
});

it("falls back to a thinking label when no tool is active", () => {
  const messages: UiMessage[] = [{ id: "assistant-1", role: "assistant", createdAt: Date.now(), parts: [] }];
  expect(render(<BotResponseStatus messages={messages} avatar={{ name: "Bot" }} />).getByRole("status").textContent).toContain("考え中");
});

it("renders the sent date and time with a machine-readable timestamp", () => {
  const createdAt = Date.UTC(2026, 8, 6, 12, 34);
  const { container, rerender } = render(<BotMessageTime createdAt={createdAt} />);
  const time = container.querySelector("time")!;
  expect(time.dateTime).toBe("2026-09-06T12:34:00.000Z");
  expect(time.textContent).toMatch(/2026\/09\/06.*\d{2}:34/);
  rerender(<BotMessageTime createdAt={NaN} />);
  expect(container.querySelector("time")).toBeNull();
});
