import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_TOOL_NAME, registerJevTool } from "./jev-tool";
import type { TypeSafeResponse } from "./typesafe-system-one";

const { mockEvaluate } = vi.hoisted(() => ({ mockEvaluate: vi.fn() }));

vi.mock("./typesafe-system-one", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./typesafe-system-one")>();
  return { ...actual, evaluateTypeSafe: mockEvaluate };
});

function tool() {
  let registered: {
    name: string;
    execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }>;
  } | undefined;
  registerJevTool({
    registerTool(candidate: unknown) { registered = candidate as never; },
  } as unknown as ExtensionAPI);
  if (!registered) throw new Error("tool not registered");
  expect(registered.name).toBe(JEV_TOOL_NAME);
  return registered;
}

const okResponse = (answers: TypeSafeResponse["answers"]): TypeSafeResponse => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 1, output_tokens: 2 },
});

describe("jev_judge tool", () => {
  beforeEach(() => { mockEvaluate.mockClear(); });
  it("returns typed answers for a noul question", async () => {
    mockEvaluate.mockResolvedValueOnce(okResponse({ ready: { type: "noul", noul: 0.9 } }));
    const result = await tool().execute("call", {
      state: "The build passed.",
      questions: [{ id: "ready", type: "noul", instructions: "Is the build ready?" }],
    });
    expect(mockEvaluate).toHaveBeenCalledWith({
      state: "The build passed.",
      model: "jev-latest",
      questions: { ready: { type: "noul", instructions: "Is the build ready?" } },
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      answers: { ready: { noul: 0.9 } },
    });
  });

  it("rejects empty state and duplicate ids before any request", async () => {
    const registered = tool();
    await expect(registered.execute("call", {
      state: "  ",
      questions: [{ id: "q", type: "noul", instructions: "Ready?" }],
    })).rejects.toThrow("must not be empty");
    await expect(registered.execute("call", {
      state: "data",
      questions: [
        { id: "q", type: "noul", instructions: "A?" },
        { id: "q", type: "noul", instructions: "B?" },
      ],
    })).rejects.toThrow("duplicate");
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it("rejects a choice answer outside the requested options", async () => {
    mockEvaluate.mockResolvedValueOnce(okResponse({
      dept: { type: "choice", choice: "unknown-team", confidence: 0.9 },
    }));
    await expect(tool().execute("call", {
      state: "Payouts failing.",
      questions: [{
        id: "dept",
        type: "choice",
        instructions: "Which team?",
        criteria: { billing: "Payments", technical: "Bugs", other: null },
      }],
    })).rejects.toThrow("not one of");
  });

  it("wraps API failures with the tool name", async () => {
    mockEvaluate.mockRejectedValueOnce(new Error("TypeSafe API error: 429"));
    await expect(tool().execute("call", {
      state: "data",
      questions: [{ id: "q", type: "noul", instructions: "Ready?" }],
    })).rejects.toThrow("Jev request failed");
  });
});
