import { expect, it } from "vitest";
import { MAX_UI_TOOL_OUTPUT_CHARS, UI_TOOL_OUTPUT_OMISSION, projectPiMessages, titleFromPrompt, truncateUiToolOutput } from "./messages";

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
function countInspected(text: string, run: () => void): number {
  const original = String.prototype[Symbol.iterator];
  let inspected = 0;
  String.prototype[Symbol.iterator] = function* (): Generator<string, undefined, unknown> {
    for (const char of original.call(this)) {
      if (this.valueOf() === text) inspected++;
      yield char;
    }
    return undefined;
  };
  try { run(); return inspected; } finally { String.prototype[Symbol.iterator] = original; }
}
it("only reads diagnostic field prefixes instead of expanding multi-MiB errors", () => {
  const text = "x".repeat(2 * 1024 * 1024);
  const inspected = countInspected(text, () => {
    const [message] = projectPiMessages([{ role: "assistant", timestamp: 1, content: [], diagnostics: [{
      type: text, error: { message: text, name: text, code: 503 },
      details: { configuredTransport: text, fallbackTransport: text, phase: text, eventsEmitted: true, requestBytes: 7 },
    }] }]);
    expect(message.diagnostics?.[0]).toEqual({ type: "x".repeat(120), error: { message: "x".repeat(4000), name: "x".repeat(120), code: 503 },
      details: { configuredTransport: "x".repeat(120), fallbackTransport: "x".repeat(120), phase: "x".repeat(120), eventsEmitted: true, requestBytes: 7 } });
  });
  expect(inspected).toBeLessThanOrEqual(4000 + 5 * 120);
});
it("only reads the bounded sender label and title prefixes", () => {
  const text = "x".repeat(2 * 1024 * 1024);
  const inspected = countInspected(text, () => {
    const [message] = projectPiMessages([{ role: "custom", customType: "intercom_message", details: { from: { name: text } } },
      { role: "assistant", timestamp: 1, content: [] }]);
    expect(message.intercom).toEqual({ from: "x".repeat(80) });
    expect(titleFromPrompt(text)).toBe("x".repeat(59) + "…");
  });
  expect(inspected).toBeLessThanOrEqual(80 + 61);
});
it("preserves Unicode diagnostic and title boundaries", () => {
  const text = "日本語😀".repeat(1500), chars = Array.from(text);
  const [message] = projectPiMessages([{ role: "assistant", timestamp: 1, content: [], diagnostics: [{ type: text, error: { message: text, name: text } }] }]);
  expect(message.diagnostics?.[0]).toEqual({ type: chars.slice(0, 120).join(""), error: { message: chars.slice(0, 4000).join(""), name: chars.slice(0, 120).join("") } });
  for (const count of [59, 60, 61]) {
    const title = "😀".repeat(count);
    expect(titleFromPrompt(title)).toBe(count > 60 ? "😀".repeat(59) + "…" : title);
  }
});
it("preserves the prior code-point truncation and omission semantics", () => {
  for (const text of ["short", "😀".repeat(15_000), "日本語😀".repeat(10_000), "x".repeat(MAX_UI_TOOL_OUTPUT_CHARS)]) {
    const expected = text.length > MAX_UI_TOOL_OUTPUT_CHARS
      ? Array.from(text).slice(0, MAX_UI_TOOL_OUTPUT_CHARS).join("") + UI_TOOL_OUTPUT_OMISSION : text;
    expect(truncateUiToolOutput(text)).toBe(expected);
  }
});
