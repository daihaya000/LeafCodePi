import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  listSubagentRuns,
  parseSubagentTranscript,
  resolveRunStatus,
  siblingArtifactPaths,
  subagentArtifactDirs,
} from "./subagent-runs";
import { projectPiMessages } from "./messages";

/** createChildTranscriptWriter が実際に書く形のレコード。 */
function record(extra: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    source: "foreground",
    runId: "run-1",
    agent: "programmer",
    childIndex: 0,
    cwd: "C:/repo",
    ts: 1000,
    timestamp: "2026-08-22T00:00:00.000Z",
    ...extra,
  });
}

const transcript = [
  record({
    recordType: "message",
    sourceEventType: "initial_prompt",
    role: "user",
    text: "PartView を直して",
    message: { role: "user", content: [{ type: "text", text: "PartView を直して" }] },
  }),
  record({
    recordType: "message",
    sourceEventType: "message_end",
    role: "assistant",
    ts: 2000,
    model: "claude-opus-5",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      provider: "anthropic",
      content: [
        { type: "text", text: "読みます" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      ],
    },
  }),
  record({ recordType: "tool_start", ts: 2100, toolCallId: "call-1", toolName: "read" }),
  record({
    recordType: "message",
    sourceEventType: "tool_result_end",
    role: "toolResult",
    ts: 2200,
    toolCallId: "call-1",
    toolName: "read",
    isError: false,
    text: "file body",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file body" }],
    },
  }),
  record({ recordType: "tool_end", ts: 2300, toolCallId: "call-1", toolName: "read" }),
].join("\n");

describe("parseSubagentTranscript", () => {
  it("collects run identity, timestamps and pi messages", () => {
    const parsed = parseSubagentTranscript(transcript);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.agent).toBe("programmer");
    expect(parsed.index).toBe(0);
    expect(parsed.firstTsMs).toBe(1000);
    expect(parsed.lastTsMs).toBe(2300);
    expect(parsed.rawMessages).toHaveLength(3);
    expect(parsed.currentTool).toBeNull();
  });

  it("projects into the same UI messages as the parent timeline", () => {
    const messages = projectPiMessages(parseSubagentTranscript(transcript).rawMessages);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const tool = messages[1]!.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      type: "tool",
      tool: "read",
      state: { status: "completed", output: "file body" },
    });
  });

  it("reports the tool still running when tool_end is missing", () => {
    const partial = [
      record({ recordType: "tool_start", toolCallId: "call-9", toolName: "bash" }),
    ].join("\n");
    expect(parseSubagentTranscript(partial).currentTool).toBe("bash");
  });

  it("skips blank and half-written lines from tail reads", () => {
    const tail = `{"recordType":"mess\n\n${record({ recordType: "tool_start", toolCallId: "c", toolName: "grep" })}`;
    const parsed = parseSubagentTranscript(tail, { truncated: true });
    expect(parsed.currentTool).toBe("grep");
    expect(parsed.truncated).toBe(true);
  });
});

describe("resolveRunStatus", () => {
  const nowMs = 10_000_000;

  it("is completed on a clean meta file", () => {
    expect(resolveRunStatus({ meta: { exitCode: 0 }, nowMs })).toBe("completed");
  });

  it("is error on non-zero exit, error text or timeout", () => {
    expect(resolveRunStatus({ meta: { exitCode: 1 }, nowMs })).toBe("error");
    expect(resolveRunStatus({ meta: { exitCode: 0, error: "boom" }, nowMs })).toBe("error");
    expect(resolveRunStatus({ meta: { exitCode: 0, timedOut: true }, nowMs })).toBe("error");
  });

  it("is running while the transcript is fresh and meta is absent", () => {
    expect(resolveRunStatus({ meta: null, lastActivityAtMs: nowMs - 5_000, nowMs })).toBe("running");
  });

  it("is stale when nothing was appended for a long time", () => {
    expect(resolveRunStatus({ meta: null, lastActivityAtMs: nowMs - 20 * 60_000, nowMs })).toBe(
      "stale",
    );
  });
});

describe("siblingArtifactPaths", () => {
  it("derives meta and output paths", () => {
    expect(siblingArtifactPaths("C:/a/run-1_programmer_0_transcript.jsonl")).toEqual({
      metaPath: "C:/a/run-1_programmer_0_meta.json",
      outputPath: "C:/a/run-1_programmer_0_output.md",
    });
  });
});

describe("listSubagentRuns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-pi-subagent-"));
  const sessionDir = path.join(root, "sessions", "key");
  const artifactsDir = path.join(sessionDir, "subagent-artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "2026_abc.jsonl");
  fs.writeFileSync(sessionFile, "");
  fs.writeFileSync(path.join(artifactsDir, "run-1_programmer_transcript.jsonl"), transcript, "utf-8");
  fs.writeFileSync(
    path.join(artifactsDir, "run-2_reviewer_transcript.jsonl"),
    [
      JSON.stringify({ recordType: "message", runId: "run-2", agent: "reviewer", ts: 5000, message: { role: "user", content: [{ type: "text", text: "見て" }] } }),
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(artifactsDir, "run-2_reviewer_meta.json"),
    JSON.stringify({ runId: "run-2", agent: "reviewer", exitCode: 1, error: "failed" }),
    "utf-8",
  );

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("discovers both runs from the session artifacts dir", () => {
    const runs = listSubagentRuns({ sessionFile, cwd: root });
    const byId = new Map(runs.map((run) => [run.runId, run]));
    expect(byId.get("run-1")?.status).toBe("running");
    expect(byId.get("run-1")?.messages).toHaveLength(2);
    expect(byId.get("run-2")?.status).toBe("error");
    expect(byId.get("run-2")?.agent).toBe("reviewer");
  });

  it("honours the since filter", () => {
    const future = Date.now() + 60_000;
    expect(listSubagentRuns({ sessionFile, sinceMs: future })).toEqual([]);
  });

  it("returns nothing without a session file", () => {
    expect(listSubagentRuns({ sessionFile: null, cwd: path.join(root, "missing") })).toEqual([]);
  });
});

describe("subagentArtifactDirs", () => {
  it("covers session, project and temp artifact roots", () => {
    const dirs = subagentArtifactDirs({
      sessionFile: "/home/.pi/agent/sessions/key/2026_abc.jsonl",
      cwd: "/repo",
      tmpDir: "/tmp",
      readTmpEntries: () => ["pi-subagents-user-x", "other"],
      exists: () => true,
    });
    expect(dirs.map((dir) => dir.replace(/\\/g, "/"))).toEqual([
      "/home/.pi/agent/sessions/key/subagent-artifacts",
      "/repo/.pi/subagents/artifacts",
      "/tmp/pi-subagents-user-x/artifacts",
    ]);
  });

  it("drops directories that do not exist", () => {
    const dirs = subagentArtifactDirs({
      sessionFile: "/s/x.jsonl",
      tmpDir: "/tmp",
      readTmpEntries: () => [],
      exists: () => false,
    });
    expect(dirs).toEqual([]);
  });
});
