import { describe, expect, it, vi } from "vitest";
import {
  capToolResultContent,
  capToolResultText,
  installToolResultCap,
  MAX_TOOL_RESULT_CHARS,
  type AfterToolCall,
  type ToolCappableAgent,
} from "./tool-result-cap";

function hookOf(agent: ToolCappableAgent): AfterToolCall {
  return agent.afterToolCall as AfterToolCall;
}

describe("tool result cap", () => {
  it("leaves output at or below the limit untouched", () => {
    const text = "a".repeat(MAX_TOOL_RESULT_CHARS);
    expect(capToolResultText(text)).toBe(text);
    expect(capToolResultContent([{ type: "text", text }])).toBeNull();
  });

  it("keeps the head and the tail of oversized output", () => {
    const text = `START${"a".repeat(60_000)}END`;
    const capped = capToolResultText(text);
    expect(capped.length).toBeLessThan(text.length);
    expect(capped.startsWith("START")).toBe(true);
    expect(capped.endsWith("END")).toBe(true);
    expect(capped).toContain("省略しました");
  });

  it("never splits a surrogate pair", () => {
    const capped = capToolResultText(`START${"🍣".repeat(40_000)}END`);
    expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(capped).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("caps text blocks and leaves other blocks alone", () => {
    const content = [
      { type: "text", text: "x".repeat(60_000) },
      { type: "image", mimeType: "image/png", data: "zzz" },
    ];
    const capped = capToolResultContent(content);
    expect(capped).not.toBeNull();
    expect((capped![0] as { text: string }).text.length).toBeLessThan(60_000);
    expect(capped![1]).toBe(content[1]);
  });

  it("caps the content an existing hook returned and keeps its other fields", async () => {
    const agent: ToolCappableAgent = {
      afterToolCall: async () => ({
        content: [{ type: "text", text: "y".repeat(60_000) }],
        isError: true,
      }),
    };

    installToolResultCap(agent);
    const result = await hookOf(agent)({
      result: { content: [{ type: "text", text: "original" }] },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const [part] = result!.content as { text: string }[];
    expect(part.text.length).toBeLessThan(60_000);
    expect(part.text.startsWith("yyy")).toBe(true);
  });

  it("does not stack wrappers when a session is configured twice", async () => {
    const previous = vi.fn(async () => undefined);
    const agent: ToolCappableAgent = { afterToolCall: previous };

    installToolResultCap(agent);
    installToolResultCap(agent);
    await hookOf(agent)({ result: { content: [{ type: "text", text: "ok" }] } });

    expect(previous).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when nothing needs capping, so details survive", async () => {
    const agent: ToolCappableAgent = {};

    installToolResultCap(agent);
    const result = await hookOf(agent)({
      result: { content: [{ type: "text", text: "short" }] },
    });

    expect(result).toBeUndefined();
  });
});
