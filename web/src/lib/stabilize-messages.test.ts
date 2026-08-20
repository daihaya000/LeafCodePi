import { describe, expect, it } from "vitest";
import { stabilizeUiMessages } from "./stabilize-messages";
import type { UiMessage } from "./types";

function textMessage(id: string, text: string, extra?: Partial<UiMessage>): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: 1,
    parts: [{ type: "text", id: `${id}-t`, text }],
    ...extra,
  };
}

describe("stabilizeUiMessages", () => {
  it("reuses references when content is unchanged", () => {
    const prev = [textMessage("a", "hello"), textMessage("b", "world")];
    const next = [textMessage("a", "hello"), textMessage("b", "world")];
    const out = stabilizeUiMessages(prev, next);
    expect(out).toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
  });

  it("updates only changed messages", () => {
    const prev = [textMessage("a", "hello"), textMessage("b", "world")];
    const next = [textMessage("a", "hello"), textMessage("b", "world!")];
    const out = stabilizeUiMessages(prev, next);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).not.toBe(prev[1]);
    expect(out[1]?.parts[0]).toMatchObject({ text: "world!" });
  });
});
