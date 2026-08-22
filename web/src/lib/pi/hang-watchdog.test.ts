import { describe, expect, it } from "vitest";
import { estimateWatchBodyBytes, progressFingerprint } from "./hang-watchdog";
import type { UiMessage } from "../types";

describe("hang-watchdog helpers", () => {
  it("estimates prompt and image payload size", () => {
    expect(
      estimateWatchBodyBytes({
        prompt: "hello",
        images: [{ mimeType: "image/png", data: "abcd" }],
      }),
    ).toBe(5 + 4 + "image/png".length);
  });

  it("builds a stable progress fingerprint", () => {
    const messages: UiMessage[] = [
      {
        id: "a1",
        role: "assistant",
        createdAt: 1,
        parts: [{ id: "t1", type: "text", text: "hi" }],
      },
    ];
    expect(progressFingerprint(messages)).toContain("assistant:a1:t:2");
  });
});
