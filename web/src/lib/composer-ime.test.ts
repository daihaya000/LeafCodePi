import { describe, expect, it } from "vitest";
import { isImeComposingEvent } from "./composer-ime";

describe("isImeComposingEvent", () => {
  it("detects native isComposing, React isComposing, and keyCode 229", () => {
    expect(isImeComposingEvent({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposingEvent({ isComposing: true })).toBe(true);
    expect(isImeComposingEvent({ keyCode: 229 })).toBe(true);
    expect(isImeComposingEvent({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
  });
});
