import { describe, expect, it, vi } from "vitest";
import {
  buildTaskBootstrap,
  sessionContextUsage,
  snapshotMessages,
} from "./harness";
import type { TaskSummary } from "@/lib/types";

describe("snapshotMessages", () => {
  it("reuses stable history while projecting a changing streaming suffix", () => {
    const stored: unknown[] = [{ role: "user", content: "確認して" }];
    const fake = {
      messages: stored,
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    const first = snapshotMessages(session);
    expect(snapshotMessages(session)).toBe(first);

    const streaming = {
      role: "assistant",
      content: [{ type: "text", text: "一" }],
    };
    fake.agent.state.streamingMessage = streaming;
    expect(snapshotMessages(session).at(-1)?.parts[0]).toMatchObject({ text: "一" });

    streaming.content[0]!.text = "二";
    expect(snapshotMessages(session).at(-1)?.parts[0]).toMatchObject({ text: "二" });
  });

  it("keeps messages before a compaction entry visible", () => {
    const before = { role: "user", content: "圧縮前" };
    const beforeAnswer = {
      role: "assistant",
      content: [{ type: "text", text: "圧縮前の回答" }],
    };
    const after = { role: "user", content: "圧縮後" };
    const branch = [
      { type: "message", id: "u1", message: before },
      { type: "message", id: "a1", message: beforeAnswer },
      {
        type: "compaction",
        id: "c1",
        timestamp: "1970-01-01T00:00:00.003Z",
        summary: "圧縮前の会話の要約",
        firstKeptEntryId: "a1",
        tokensBefore: 42_000,
      },
      { type: "message", id: "u2", message: after },
    ];
    const fake = {
      messages: [
        { role: "compactionSummary", summary: "圧縮前の会話の要約" },
        after,
      ],
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => "u2", getBranch: () => branch },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    expect(snapshotMessages(session).map((message) => message.id)).toEqual(["u1", "a1", "c1", "u2"]);
    expect(snapshotMessages(session)[0]?.parts[0]).toMatchObject({ text: "圧縮前" });
  });

  it("projects a streaming delta without rereading the cached branch", () => {
    const stored: unknown[] = [{ role: "user", content: "確認して" }];
    const branch = [{ type: "message", id: "u1", message: stored[0] }];
    const streaming = {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "一" }],
    };
    let branchReads = 0;
    const fake = {
      messages: stored,
      agent: { state: { streamingMessage: streaming as unknown } },
      sessionManager: {
        getLeafId: () => "u1",
        getBranch: () => {
          branchReads += 1;
          return branch;
        },
      },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    snapshotMessages(session);
    branchReads = 0;
    streaming.content[0]!.text = "二";
    const latest = snapshotMessages(
      session,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ).at(-1);

    expect(branchReads).toBe(0);
    expect(latest).toMatchObject({
      id: "msg-1",
      role: "assistant",
      parts: [{ type: "text", text: "二" }],
    });
    expect(latest).toEqual(snapshotMessages(session).at(-1));
  });
});

describe("sessionContextUsage", () => {
  it("reuses the estimate while session messages are unchanged", () => {
    const stored: unknown[] = [{ role: "user", content: "確認して" }];
    const getContextUsage = vi.fn().mockReturnValue({
      tokens: 100,
      contextWindow: 10_000,
      percent: 1,
    });
    const fake = {
      messages: stored,
      getContextUsage,
    };
    const session = fake as unknown as Parameters<typeof sessionContextUsage>[0];

    const first = sessionContextUsage(session);
    expect(first).toEqual({ tokens: 100, contextWindow: 10_000, percent: 1 });
    expect(sessionContextUsage(session)).toBe(first);
    expect(getContextUsage).toHaveBeenCalledTimes(1);

    stored.push({ role: "assistant", content: [{ type: "text", text: "回答" }] });
    getContextUsage.mockReturnValue({
      tokens: 200,
      contextWindow: 10_000,
      percent: 2,
    });
    expect(sessionContextUsage(session)?.tokens).toBe(200);
    expect(getContextUsage).toHaveBeenCalledTimes(2);
  });
});

describe("buildTaskBootstrap", () => {
  const task: TaskSummary = {
    id: "task-1",
    projectId: "project-1",
    projectName: "Project",
    title: "応答を速くする",
    directory: "C:\\project",
    isolation: "current_folder",
    status: "working",
    sessionId: "session-1",
    sessionFile: "C:\\session.jsonl",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("returns immediately renderable metadata without session history", () => {
    const bootstrap = buildTaskBootstrap(task);
    expect(bootstrap.title).toBe(task.title);
    expect(bootstrap.messages).toEqual([]);
    expect(bootstrap.isStreaming).toBe(true);
    expect(bootstrap.isCompacting).toBe(false);
  });

  it("uses the supplied streaming state for a cold idle task", () => {
    expect(buildTaskBootstrap({ ...task, status: "idle" }, true).isStreaming).toBe(true);
  });
});
