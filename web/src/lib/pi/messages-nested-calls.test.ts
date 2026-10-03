import { describe, expect, it } from "vitest";
import { nestedCallsFromRaw, projectPiMessages } from "./messages";

const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: { code: "x" } });
const toolPart = (messages: ReturnType<typeof projectPiMessages>) =>
  messages.flatMap((message) => message.parts).find((part) => part.type === "tool");

describe("nested tool calls", () => {
  it("keeps what ran and how it ended, without arguments", () => {
    const messages = projectPiMessages([
      { role: "assistant", id: "a1", timestamp: 1, content: [call("c1", "codemode")] },
      {
        role: "toolResult", toolCallId: "c1", toolName: "codemode", isError: false, timestamp: 2,
        content: [{ type: "text", text: "Script completed" }],
        nestedCalls: [
          { id: "c1/1", name: "read", status: "ok", durationMs: 12, arguments: { path: "secret.txt" } },
          { id: "c1/2", name: "powershell", status: "error", durationMs: 3, error: "blocked" },
        ],
      },
    ]);
    const part = toolPart(messages);
    expect(part?.type === "tool" && part.state.nestedCalls).toEqual([
      { id: "c1/1", name: "read", status: "ok", durationMs: 12 },
      { id: "c1/2", name: "powershell", status: "error", durationMs: 3, error: "blocked" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("secret.txt");
  });

  it("leaves the state unchanged when a tool made no nested call", () => {
    const messages = projectPiMessages([
      { role: "assistant", id: "a1", timestamp: 1, content: [call("c1", "read")] },
      { role: "toolResult", toolCallId: "c1", toolName: "read", timestamp: 2, content: [{ type: "text", text: "ok" }] },
    ]);
    const part = toolPart(messages);
    expect(part?.type === "tool" && "nestedCalls" in part.state).toBe(false);
  });
});

describe("nestedCallsFromRaw", () => {
  it("drops malformed rows, clips errors and bounds the count", () => {
    const rows = [
      null, "x", { id: "a", name: "read", status: "weird" }, { id: "", name: "read", status: "ok" },
      { id: "b", name: "read", status: "unfinished", durationMs: -1 },
      { id: "c", name: "read", status: "error", error: "e".repeat(900) },
    ];
    const result = nestedCallsFromRaw(rows);
    expect(result.map((row) => row.id)).toEqual(["b", "c"]);
    expect(result[0]).toEqual({ id: "b", name: "read", status: "unfinished" });
    expect(result[1]?.error).toHaveLength(500);
    expect(nestedCallsFromRaw(undefined)).toEqual([]);
    const many = Array.from({ length: 300 }, (_, index) => ({ id: `n${index}`, name: "read", status: "ok" }));
    expect(nestedCallsFromRaw(many)).toHaveLength(256);
  });
});
