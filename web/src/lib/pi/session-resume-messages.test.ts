import { expect, it } from "vitest";
import { entryIdsForProjectedMessages, piRawMessageProjectsToUi, projectPiMessages } from "./messages";

const marker = () => ({
  id: "resume", role: "custom", customType: "leafcode-session-resume-trigger", display: true, timestamp: 100,
  content: "Private scheduler instructions", details: { uiPrompt: "【予約再開】\n処理結果を確認する" },
});
it("projects a labelled automatic continuation and retains its durable entry id", () => {
  const message = marker();
  const projected = projectPiMessages([message]);
  expect(piRawMessageProjectsToUi(message)).toBe(true);
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({ id: "resume", role: "assistant", createdAt: 100,
    parts: [{ type: "text", text: "【予約再開】\n処理結果を確認する" }] });
  expect(JSON.stringify(projected)).not.toContain("Private scheduler instructions");
  expect(entryIdsForProjectedMessages([message], new Map([[message, "entry-resume"]]))).toEqual(["entry-resume"]);
});
it("never reveals raw instructions without explicit labelled display text", () => {
  const message = marker();
  for (const candidate of [
    { ...message, display: false },
    { ...message, details: undefined },
    { ...message, details: { uiPrompt: "unlabelled" } },
    { ...message, details: { uiPrompt: "【予約再開】\n" + "x".repeat(4100) } },
  ]) {
    expect(piRawMessageProjectsToUi(candidate)).toBe(false);
    expect(projectPiMessages([candidate])).toEqual([]);
  }
});
it("does not attach a previous Goal Loop turn to the resumed response", () => {
  const projected = projectPiMessages([
    { role: "custom", customType: "leafcode-goal-turn", details: { turn: 1, maxTurns: 2, kind: "goal" } },
    marker(),
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
  expect(projected.every((message) => !message.goalLoopTurn)).toBe(true);
});
