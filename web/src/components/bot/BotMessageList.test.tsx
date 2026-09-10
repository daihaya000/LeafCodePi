// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BotChatMessage, BotMessageError, BotMessageImages, BotMessageList, BotMessageMarkdown, BotMessageRow, BotMessageSender, BotMessageTime, BotPermissionCard, BotResponseStatus, BotRevertButton } from "./BotMessageList";
import type { UiMessage } from "@/lib/types";
import { formatMessageTime } from "../ui";

afterEach(cleanup);

it("follows loaded history and streaming, preserves reading position, and resets on conversation switch", () => {
  const loading = { id: "loading" };
  const history = { id: "history" };
  const streaming = { id: "streaming" };
  const { getByRole, rerender } = render(<BotMessageList conversationId="a" contentKey={loading}>Loading</BotMessageList>);
  const viewport = getByRole("main");
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } });
  rerender(<BotMessageList conversationId="a" contentKey={history}>History</BotMessageList>);
  expect(viewport.scrollTop).toBe(1000);
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  rerender(<BotMessageList conversationId="a" contentKey={streaming}>New message</BotMessageList>);
  expect(viewport.scrollTop).toBe(100);
  rerender(<BotMessageList conversationId="b" contentKey={history}>Other history</BotMessageList>);
  expect(viewport.scrollTop).toBe(1000);
  viewport.scrollTop = 800;
  fireEvent.scroll(viewport);
  Object.defineProperty(viewport, "scrollHeight", { value: 1200 });
  rerender(<BotMessageList conversationId="b" contentKey={streaming}>Streaming</BotMessageList>);
  expect(viewport.scrollTop).toBe(1200);
});

it("does not scroll when only the rendered children change", () => {
  const content = { id: "messages" };
  const { getByRole, rerender } = render(<BotMessageList conversationId="a" contentKey={content}>First</BotMessageList>);
  const viewport = getByRole("main");
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } });
  viewport.scrollTop = 100;
  rerender(<BotMessageList conversationId="a" contentKey={content}>Updated prompt-only child</BotMessageList>);
  expect(viewport.scrollTop).toBe(100);
});

it("places the time and footer below the bubble for user messages", () => {
  const createdAt = Date.UTC(2026, 8, 8, 2, 58);
  const { container, rerender } = render(<BotMessageRow user createdAt={createdAt} footer={<button type="button">入力欄に戻す</button>}>エージェントは？</BotMessageRow>);
  const row = container.firstElementChild!;
  expect(row.className).toContain("items-end");
  expect([...row.children].map((child) => child.tagName)).toEqual(["DIV", "TIME", "BUTTON"]);
  const bubble = row.children[0];
  expect(bubble.className).toContain("max-w-bubble");
  expect(bubble.className).toContain("bg-bot-user");

  rerender(<BotMessageRow user={false} createdAt={createdAt} header={<BotMessageSender name="MiMo" avatarColor="#0071E3" />}><BotMessageError text="応答に失敗しました" /></BotMessageRow>);
  const botRow = container.firstElementChild!;
  expect(botRow.className).toContain("items-start");
  expect(botRow.children[0].textContent).toBe("MiMo");
  expect(botRow.children[1].className).toContain("bg-bot-assistant");
  expect(botRow.querySelector("[role='alert']")?.textContent).toBe("応答に失敗しました");

  rerender(<BotMessageSender name="プログラマー" createdAt={createdAt} avatarColor="#0071E3" />);
  expect(container.querySelector("time")?.textContent).toBe(formatMessageTime(createdAt));
});

it("renders bot Markdown with GFM", () => {
  const { container } = render(<BotMessageMarkdown text={"**bold**\n\n- item"} />);
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("ul li")?.textContent).toBe("item");
});

it("turns bare internal task paths into task cards", async () => {
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve({ ok: true, json: async () => url.startsWith("/api/tasks/")
    ? { task: { id: "task-123", title: "Fix login", projectId: null } }
    : { projects: [] } })));
  const { findByRole } = render(<BotMessageMarkdown text="タスク: /task/task-123" />);
  const taskLink = await findByRole("link", { name: "Fix login" });
  expect(taskLink.getAttribute("href")).toBe("/task/task-123");
});

it("renders internal task links with the task title and project icon", async () => {
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve({ ok: true, json: async () => url.startsWith("/api/tasks/")
    ? { task: { id: "task/123", title: "Fix login", projectId: "project" } }
    : { projects: [{ id: "project", name: "App", icon: "data:image/png;base64,icon" }] } })));
  const { findByRole, getByRole } = render(<BotMessageMarkdown text={"[Code task](/task/task%2F123) [Docs](https://example.com)"} />);
  const taskLink = await findByRole("link", { name: "Fix login" });
  expect(taskLink.getAttribute("href")).toBe("/task/task%2F123");
  expect(taskLink.textContent).toBe("Fix login");
  expect(taskLink.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,icon");
  expect(getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("https://example.com");
});

it("places image attachments below the message text", () => {
  const { container } = render(<BotChatMessage
    user
    createdAt={1}
    sender={{ name: "Sender" }}
    text="Message"
    images={<span data-testid="attachment">Image</span>}
  />);
  const bubble = container.querySelector(".bot-message-bubble")!;
  expect([...bubble.children].map((child) => child.getAttribute("data-testid"))).toEqual([null, "attachment"]);
});

it("shares sender/time placement and Room mention chips across conversation messages", () => {
  const props = { createdAt: 1, sender: { name: "Sender" }, text: "Hello @here\n\n- item" };
  const { container, rerender } = render(<BotChatMessage {...props} user={false} />);
  const bubble = container.querySelector(".bot-message-bubble")!;
  expect(bubble.textContent).not.toContain("Sender");
  expect(container.querySelectorAll("time")).toHaveLength(1);
  expect(bubble.previousElementSibling?.querySelector("time")).toBeTruthy();
  expect(bubble.querySelector("ul li")?.textContent).toBe("item");
  rerender(<BotChatMessage {...props} user />);
  expect(container.querySelector("[data-mention='@here']")?.className).toContain("bg-white/90");
  expect(container.querySelector(".bot-message-bubble")?.nextElementSibling?.tagName).toBe("TIME");
});

it("shows the animated bot and the current tool action while responding", () => {
  const messages: UiMessage[] = [{
    id: "assistant-1",
    role: "assistant",
    createdAt: Date.now(),
    parts: [{ id: "tool-1", type: "tool", tool: "read", callID: "call-1", state: { status: "running", input: { path: "README.md" } } }],
  }];
  const { container, getByRole } = render(<BotResponseStatus messages={messages} avatar={{ name: "Bot", avatarColor: "#0071E3" }} />);
  expect(getByRole("status").textContent).toContain("応答中…");
  expect(getByRole("status").textContent).toContain("読取");
  expect(container.querySelector(".bot-avatar-working")).toBeTruthy();
});

it("falls back to a thinking label when no tool is active", () => {
  const messages: UiMessage[] = [{ id: "assistant-1", role: "assistant", createdAt: Date.now(), parts: [] }];
  expect(render(<BotResponseStatus messages={messages} avatar={{ name: "Bot" }} />).getByRole("status").textContent).toContain("考え中");
});

it("shares one revert button so Bot and Room labels and disabled state stay identical", () => {
  const onClick = vi.fn();
  const { getByRole, rerender } = render(<BotRevertButton title="この発言以降を入力欄に戻して巻き戻す" onClick={onClick} />);
  const button = getByRole("button", { name: /入力欄に戻す/ });
  expect(button.title).toBe("この発言以降を入力欄に戻して巻き戻す");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
  rerender(<BotRevertButton title="t" disabled onClick={onClick} />);
  fireEvent.click(getByRole("button", { name: /入力欄に戻す/ }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("shares one attachment strip and falls back to the default alt text", () => {
  const { container, getAllByRole, rerender } = render(<BotMessageImages images={[
    { key: "a", src: "/a.png" },
    { key: "b", src: "/b.png", alt: "図面" },
  ]} />);
  expect(getAllByRole("img").map((image) => [image.getAttribute("src"), image.getAttribute("alt")]))
    .toEqual([["/a.png", "添付画像"], ["/b.png", "図面"]]);
  rerender(<BotMessageImages images={[]} />);
  expect(container.firstChild).toBeNull();
});

it("shares one permission card so Bot and Room only differ by label", () => {
  const onAllow = vi.fn();
  const onDeny = vi.fn();
  const { getByRole, rerender } = render(<BotPermissionCard label="権限の確認" title="権限の確認が必要です" message="Codeへ依頼します" command="code_session" onAllow={onAllow} onDeny={onDeny} />);
  const card = getByRole("alertdialog", { name: "権限の確認" });
  expect(card.textContent).toContain("権限の確認が必要です");
  expect(card.querySelector("pre")!.textContent).toBe("code_session");
  fireEvent.click(getByRole("button", { name: "許可" }));
  fireEvent.click(getByRole("button", { name: "拒否" }));
  expect([onAllow.mock.calls.length, onDeny.mock.calls.length]).toEqual([1, 1]);

  rerender(<BotPermissionCard label="Alphaの権限確認" title="Alpha：権限の確認が必要です" message="m" command="c" disabled onAllow={onAllow} onDeny={onDeny} />);
  expect(getByRole("alertdialog", { name: "Alphaの権限確認" })).toBeTruthy();
  fireEvent.click(getByRole("button", { name: "許可" }));
  expect(onAllow).toHaveBeenCalledTimes(1);
});

it("renders the sent date and time with a machine-readable timestamp", () => {
  const createdAt = Date.UTC(2026, 8, 6, 12, 34);
  const { container, rerender } = render(<BotMessageTime createdAt={createdAt} />);
  const time = container.querySelector("time")!;
  expect(time.dateTime).toBe("2026-09-06T12:34:00.000Z");
  expect(time.textContent).toBe(formatMessageTime(createdAt));
  rerender(<BotMessageTime createdAt={NaN} />);
  expect(container.querySelector("time")).toBeNull();
});
