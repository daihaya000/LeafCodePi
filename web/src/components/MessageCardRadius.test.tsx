// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ActivityLog, MessageBubble } from "./ConversationLayout";
import { BotComposer } from "./bot/BotComposer";
import { CodeRequestCard } from "./bot/CodeRequestCard";
import { ToolCard } from "./task/PartView";
import { QuestionCard } from "./task/QuestionCard";

it("uses the shared card radius across chat and request cards", () => {
  const { container } = render(<>
    <MessageBubble user>ユーザー</MessageBubble>
    <MessageBubble>エージェント</MessageBubble>
    <ToolCard part={{ id: "tool", type: "tool", tool: "read", callID: "call", state: { status: "completed", input: {} } }} />
    <ActivityLog kind="task" count={1} parts={[]} active={false}>作業ログ</ActivityLog>
    <CodeRequestCard state="delivered" />
    <QuestionCard
      request={{ id: "question", sessionId: "session", questions: [{ question: "確認", options: [], multiple: false, custom: false }] }}
      onReply={async () => {}}
      onReject={async () => {}}
    />
    <BotComposer value="" onChange={() => {}} onKeyDown={() => {}} placeholder="入力" onSend={() => {}} />
  </>);
  const cards = [...container.children].slice(0, 6);
  const composer = container.querySelector(".bot-composer-shell");
  expect(cards).toHaveLength(6);
  expect(composer?.classList.contains("rounded-card")).toBe(true);
  for (const card of cards) {
    expect(card.classList.contains("rounded-card")).toBe(true);
  }
});
