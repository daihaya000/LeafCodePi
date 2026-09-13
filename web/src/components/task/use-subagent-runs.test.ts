// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson }));

import {
  matchSubagentRuns,
  sameSubagentRuns,
  subagentAgentNames,
  useSubagentRuns,
} from "./use-subagent-runs";
import type { SubagentRunDto } from "@/lib/types";

function run(runId: string, agent: string): SubagentRunDto {
  return {
    runId,
    agent,
    status: "completed",
    startedAtMs: 0,
    lastActivityAtMs: 0,
    currentTool: null,
    truncated: false,
    messages: [],
  };
}

describe("subagentAgentNames", () => {
  it("reads single, parallel and chain shapes", () => {
    expect(subagentAgentNames({ agent: "programmer" })).toEqual(["programmer"]);
    expect(subagentAgentNames({ subagent_type: "code-reviewer" })).toEqual(["code-reviewer"]);
    expect(
      subagentAgentNames({ tasks: [{ agent: "a" }, { agent: "b" }, "c"] }),
    ).toEqual(["a", "b", "c"]);
  });

  it("is empty for unrelated input", () => {
    expect(subagentAgentNames({ command: "ls" })).toEqual([]);
    expect(subagentAgentNames(undefined)).toEqual([]);
  });
});

describe("matchSubagentRuns", () => {
  const runs = [run("r1", "programmer"), run("r2", "code-reviewer")];

  it("prefers exact run ids", () => {
    expect(matchSubagentRuns(runs, ["r2"], ["programmer"]).map((r) => r.runId)).toEqual(["r2"]);
  });

  it("falls back to agent names when ids do not match", () => {
    expect(matchSubagentRuns(runs, ["gone"], ["Code-Reviewer"]).map((r) => r.runId)).toEqual(["r2"]);
  });

  it("keeps every run in the time window when nothing matches", () => {
    expect(matchSubagentRuns(runs, [], ["other"]).map((r) => r.runId)).toEqual(["r1", "r2"]);
  });
});

describe("useSubagentRuns", () => {
  afterEach(() => {
    cleanup();
    getJson.mockReset();
  });

  it("clears runs from the previous task before the next response arrives", async () => {
    let resolveNext!: (value: { runs: SubagentRunDto[] }) => void;
    const nextResponse = new Promise<{ runs: SubagentRunDto[] }>((resolve) => {
      resolveNext = resolve;
    });
    getJson.mockImplementation((path: string) =>
      path.includes("task-a")
        ? Promise.resolve({ runs: [run("r1", "programmer")] })
        : nextResponse,
    );

    const initialProps = {
      taskId: "task-a",
      enabled: true,
      live: false,
      runIds: [] as string[],
      agentNames: [] as string[],
    };
    const { result, rerender } = renderHook((props) => useSubagentRuns(props), {
      initialProps,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.runs.map((item) => item.runId)).toEqual(["r1"]);

    await act(async () => {
      rerender({ ...initialProps, taskId: "task-b" });
    });
    expect(result.current.runs).toEqual([]);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveNext({ runs: [] });
      await Promise.resolve();
    });
  });
});

describe("sameSubagentRuns", () => {
  it("detects identical content across polling responses", () => {
    const messages = [{ id: "m1", role: "assistant" as const, createdAt: 1, parts: [] }];
    const a = [
      { ...run("r1", "programmer"), messages },
      { ...run("r2", "reviewer"), messages },
    ];
    const b = [
      { ...run("r1", "programmer"), messages },
      { ...run("r2", "reviewer"), messages },
    ];
    expect(sameSubagentRuns(a, b)).toBe(true);
  });

  it("detects a status change", () => {
    const a = [run("r1", "programmer")];
    const b = [{ ...run("r1", "programmer"), status: "running" as const }];
    expect(sameSubagentRuns(a, b)).toBe(false);
  });

  it("detects a message reference change", () => {
    const a = [run("r1", "programmer")];
    const b = [{ ...run("r1", "programmer"), messages: [{ id: "x", role: "user" as const, createdAt: 1, parts: [] }] }];
    expect(sameSubagentRuns(a, b)).toBe(false);
  });
});
