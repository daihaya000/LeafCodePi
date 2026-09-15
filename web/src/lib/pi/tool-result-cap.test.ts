import { describe, expect, it } from "vitest";
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

  it("returns undefined when nothing needs capping, so details survive", async () => {
    const agent: ToolCappableAgent = {};

    installToolResultCap(agent);
    const result = await hookOf(agent)({
      result: { content: [{ type: "text", text: "short" }] },
    });

    expect(result).toBeUndefined();
  });
});
