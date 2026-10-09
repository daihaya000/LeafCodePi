import { expect, it } from "vitest";
import { MAX_UI_TOOL_OUTPUT_CHARS, UI_TOOL_OUTPUT_OMISSION, truncateUiToolOutput } from "./messages";

it("only iterates the bounded prefix of a multi-MiB tool result", () => {
  const text = "x".repeat(2 * 1024 * 1024), original = String.prototype[Symbol.iterator];
  let inspected = 0;
  String.prototype[Symbol.iterator] = function* (): Generator<string, undefined, unknown> {
    for (const char of original.call(this)) {
      if (this.valueOf() === text) inspected++;
      yield char;
    }
    return undefined;
  };
  try {
    expect(truncateUiToolOutput(text)).toBe("x".repeat(MAX_UI_TOOL_OUTPUT_CHARS) + UI_TOOL_OUTPUT_OMISSION);
    expect(inspected).toBeLessThanOrEqual(MAX_UI_TOOL_OUTPUT_CHARS + 1);
  } finally { String.prototype[Symbol.iterator] = original; }
});
it("preserves the prior code-point truncation and omission semantics", () => {
  for (const text of ["short", "😀".repeat(15_000), "日本語😀".repeat(10_000), "x".repeat(MAX_UI_TOOL_OUTPUT_CHARS)]) {
    const expected = text.length > MAX_UI_TOOL_OUTPUT_CHARS
      ? Array.from(text).slice(0, MAX_UI_TOOL_OUTPUT_CHARS).join("") + UI_TOOL_OUTPUT_OMISSION : text;
    expect(truncateUiToolOutput(text)).toBe(expected);
  }
});
