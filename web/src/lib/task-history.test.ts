import { describe, expect, it } from "vitest";
import {
  InvalidTaskMessageCursorError,
  mergeNewerTaskMessages,
  pageTaskMessages,
  prependOlderTaskMessages,
} from "./task-history";
import type { UiMessage } from "./types";

function message(id: string, createdAt = 1): UiMessage {
  return {
    id,
    role: "user",
    createdAt,
    parts: [{ id: `${id}:text`, type: "text", text: id }],
  };
}

describe("task history pagination", () => {
  it("returns the latest page and a cursor for older messages", () => {
    const messages = Array.from({ length: 5 }, (_, index) => message(`m${index}`, index));
    expect(pageTaskMessages(messages, null, 2)).toEqual({
      messages: messages.slice(3),
      messageHistory: { hasMore: true, nextCursor: "m3" },
    });
    expect(pageTaskMessages(messages, "m3", 2)).toEqual({
      messages: messages.slice(1, 3),
      messageHistory: { hasMore: true, nextCursor: "m1" },
    });
    expect(pageTaskMessages(messages, "m1", 2).messageHistory).toEqual({
      hasMore: false,
      nextCursor: null,
    });
  });

  it("rejects a cursor from another branch", () => {
    expect(() => pageTaskMessages([message("m1")], "missing", 2)).toThrow(
      InvalidTaskMessageCursorError,
    );
  });

  it("merges live tail updates without dropping loaded older pages", () => {
    const old = message("old", 1);
    const tail = message("tail", 2);
    const updatedTail: UiMessage = {
      ...tail,
      parts: [{ id: "tail:text", type: "text", text: "updated" }],
    };
    const merged = mergeNewerTaskMessages([old, tail], [tail, message("new", 3), updatedTail]);
    expect(merged.map((item) => item.id)).toEqual(["old", "tail", "new"]);
    expect(merged[1]?.parts[0]).toMatchObject({ text: "updated" });
  });

  it("prepends an older page and deduplicates its boundary", () => {
    const current = [message("m3"), message("m4")];
    const merged = prependOlderTaskMessages(current, [message("m1"), message("m2"), message("m3")]);
    expect(merged.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });
});
