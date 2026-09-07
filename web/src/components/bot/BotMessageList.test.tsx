// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BotMessageList, BotMessageMarkdown, BotMessageTime } from "./BotMessageList";

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

it("renders bot Markdown with GFM", () => {
  const { container } = render(<BotMessageMarkdown text={"**bold**\n\n- item"} />);
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("ul li")?.textContent).toBe("item");
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
