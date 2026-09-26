// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ActivityLog, MessageBubble } from "./ConversationLayout";
import { BotComposer } from "./bot/BotComposer";
import { ToolCard } from "./task/PartView";

it("uses the shared card radius for composer, user, assistant, tool, and activity cards", () => {
  const { container } = render(<>
    <MessageBubble user>ユーザー</MessageBubble>
    <MessageBubble>エージェント</MessageBubble>
    <ToolCard part={{ id: "tool", type: "tool", tool: "read", callID: "call", state: { status: "completed", input: {} } }} />
    <ActivityLog kind="task" count={1} parts={[]} active={false}>作業ログ</ActivityLog>
    <BotComposer value="" onChange={() => {}} onKeyDown={() => {}} placeholder="入力" onSend={() => {}} />
  </>);
  const cards = [...container.children].slice(0, 4);
  const composer = container.querySelector(".bot-composer-shell");
  expect(cards).toHaveLength(4);
  expect(composer?.classList.contains("rounded-card")).toBe(true);
  for (const card of cards) {
    expect(card.classList.contains("rounded-card")).toBe(true);
  }
});
