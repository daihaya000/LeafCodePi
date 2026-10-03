// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NestedToolCallDto, UiMessage } from "@/lib/types";
import { toolInputFields, toolLabel, toolSummary } from "@/lib/tool-labels";
import { PartView } from "./PartView";

const CODE = '// @options: {"timeout_ms": 60000}\n\nconst files = await tools.grep({ pattern: "TODO" });\nreturn files.length;';

function scriptMessage(nestedCalls?: NestedToolCallDto[]): UiMessage {
  return {
    id: "assistant-script",
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        id: "tool-script",
        type: "tool",
        tool: "codemode",
        callID: "call-1",
        state: {
          status: "completed",
          input: { code: CODE },
          output: "Script completed\n3",
          title: "codemode",
          ...(nestedCalls ? { nestedCalls } : {}),
        },
      },
    ],
  };
}

describe("codemode labels", () => {
  it("names the tool and summarises the script by its first real line", () => {
    expect(toolLabel("codemode")).toBe("スクリプト");
    expect(toolSummary("codemode", { status: "completed", input: { code: CODE } })).toBe(
      'const files = await tools.grep({ pattern: "TODO" });',
    );
    expect(toolSummary("codemode", { status: "completed" })).toBe("スクリプト");
    expect(toolInputFields("codemode", { code: CODE })).toEqual([{ label: "コード", value: CODE }]);
  });
});

describe("PartView nested calls", () => {
  afterEach(() => cleanup());

  it("lists what a script ran after the card is opened", () => {
    render(
      <PartView
        message={scriptMessage([
          { id: "call-1/1", name: "grep", status: "ok", durationMs: 12 },
          { id: "call-1/2", name: "mcp__fixture__echo", status: "error", durationMs: 1500, error: "接続できません" },
          { id: "call-1/3", name: "read", status: "unfinished" },
        ])}
      />,
    );
    expect(screen.queryByText("grep")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("内部呼び出し（3件）")).toBeTruthy();
    expect(screen.getByText("grep")).toBeTruthy();
    expect(screen.getByText("12ms")).toBeTruthy();
    expect(screen.getByText("mcp__fixture__echo")).toBeTruthy();
    expect(screen.getByText("接続できません")).toBeTruthy();
    expect(screen.getByText("2s")).toBeTruthy();
    expect(screen.getByText("未完了")).toBeTruthy();
  });

  it("shows no list for a tool that made no nested call", () => {
    render(<PartView message={scriptMessage()} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByText(/内部呼び出し/)).toBeNull();
  });
});
