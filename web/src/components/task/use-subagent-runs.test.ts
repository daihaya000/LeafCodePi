import { describe, expect, it } from "vitest";
import {
  matchSubagentRuns,
  sameSubagentRuns,
  subagentAgentNames,
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
