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

  it("keeps projection caches isolated between sessions", () => {
    const createSession = (text: string) => ({
      messages: [{ role: "user", content: text }],
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    }) as unknown as Parameters<typeof snapshotMessages>[0];

    const first = snapshotMessages(createSession("最初の会話"));
    const second = snapshotMessages(createSession("別の会話"));

    expect(first).not.toBe(second);
    expect(first[0]?.parts[0]).toMatchObject({ text: "最初の会話" });
    expect(second[0]?.parts[0]).toMatchObject({ text: "別の会話" });
  });

  it("records the generating account and keeps it after rerouting", () => {
    const stored: unknown[] = [
      { role: "user", content: "確認して" },
      { role: "assistant", content: [{ type: "text", text: "回答" }] },
    ];
    const fake = {
      messages: stored,
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];
    const byMessageId = new Map<string, string>();

    const first = snapshotMessages(
      session,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { accountId: "acc-1", byMessageId },
    );
    expect(first.find((message) => message.role === "assistant")?.accountId).toBe("acc-1");

    // アカウント切替（セッション置き換え）後の再射影でも過去メッセージは保持する。
    const second = snapshotMessages(
      session,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { accountId: "acc-2", byMessageId },
    );
    expect(second.find((message) => message.role === "assistant")?.accountId).toBe("acc-1");
  });

  it("records the generating agent and keeps it after rerouting", () => {
    const stored: unknown[] = [
      { role: "user", content: "確認して" },
      { role: "assistant", content: [{ type: "text", text: "build の回答" }] },
    ];
    const fake = {
      messages: stored,
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];
    const agentByMessageId = new Map<string, string | null>();
    const first = snapshotMessages(
      session,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { accountId: null, byMessageId: new Map(), agentName: "build", agentByMessageId },
    );
    expect(first.find((message) => message.role === "assistant")?.agent).toBe("build");

    // Composerで役職を変更しても、既存メッセージは生成時の役職を維持する。
    const second = snapshotMessages(
      session,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { accountId: null, byMessageId: new Map(), agentName: "plan", agentByMessageId },
    );
    expect(second.find((message) => message.role === "assistant")?.agent).toBe("build");
  });

  it("projects agent-switch boundaries for archived transcripts", () => {
    const stored: unknown[] = [
      { role: "user", content: "最初" },
      { role: "assistant", content: [{ type: "text", text: "build の回答" }] },
      {
        role: "custom",
        customType: "leafcode-pi.agent-switch",
        content: "[Session notice] persona switched",
        details: { previousAgent: "build", nextAgent: "plan" },
      },
      { role: "user", content: "続き" },
      { role: "assistant", content: [{ type: "text", text: "plan の回答" }] },
    ];
    const fake = {
      messages: stored,
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];
    const assistants = snapshotMessages(session).filter((message) => message.role === "assistant");
    expect(assistants.map((message) => message.agent)).toEqual(["build", "plan"]);
  });

  it("assigns the new account to messages added after rerouting", () => {
    const stored: unknown[] = [
      { role: "user", content: "確認して" },
      { role: "assistant", content: [{ type: "text", text: "回答" }] },
    ];
    const fake = {
      messages: stored,
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];
    const byMessageId = new Map<string, string>();
    snapshotMessages(
      session,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { accountId: "acc-1", byMessageId },
    );

    stored.push({ role: "user", content: "続き" });
    stored.push({ role: "assistant", content: [{ type: "text", text: "次の回答" }] });
    const second = snapshotMessages(
      session,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { accountId: "acc-2", byMessageId },
    );
    const assistants = second.filter((message) => message.role === "assistant");
    expect(assistants[0]?.accountId).toBe("acc-1");
    expect(assistants[1]?.accountId).toBe("acc-2");
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

  it("projects Goal Loop turn metadata from the persisted branch", () => {
    const goalPrompt = {
      role: "custom",
      customType: "leafcode-goal-turn",
      content: "<!-- webui-goal-loop-prompt -->\\n\\nRules: internal instructions",
      display: false,
      details: { goalId: "loop-1", turn: 1, kind: "goal", uiPrompt: "ユーザーの依頼" },
      timestamp: 2,
    };
    const continuation = {
      type: "custom_message",
      id: "goal-turn-2",
      timestamp: "1970-01-01T00:00:00.003Z",
      customType: "leafcode-goal-turn",
      content: "continuation internal instructions",
      display: false,
      details: { goalId: "loop-1", turn: 2, kind: "goal" },
    };
    const branch = [
      {
        type: "custom_message",
        id: "goal-entry",
        timestamp: "1970-01-01T00:00:00.002Z",
        customType: goalPrompt.customType,
        content: goalPrompt.content,
        display: false,
        details: goalPrompt.details,
      },
      continuation,
      {
        type: "message",
        id: "assistant-entry",
        message: {
          role: "assistant",
          timestamp: 4,
          content: [{ type: "text", text: "二巡目の応答" }],
        },
      },
    ];
    const fake = {
      messages: [],
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => "assistant-entry", getBranch: () => branch },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    const projected = snapshotMessages(session);
    expect(projected).toMatchObject([
      {
        id: "goal-entry",
        role: "user",
        goalLoopTurn: { goalId: "loop-1", turn: 1, kind: "goal" },
        parts: [{ type: "text", text: "ユーザーの依頼" }],
      },
      {
        id: "assistant-entry",
        role: "assistant",
        goalLoopTurn: { goalId: "loop-1", turn: 2, kind: "goal" },
        parts: [{ type: "text", text: "二巡目の応答" }],
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("internal instructions");
  });

  it("keeps Goal Loop metadata on latest-only projections", () => {
    const marker = {
      role: "custom",
      customType: "leafcode-goal-turn",
      content: "internal prompt",
      display: false,
      details: { goalId: "loop-1", turn: 2, kind: "goal" },
      timestamp: 1,
    };
    const streaming = {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "ストリーミング中" }],
    };
    const branch = [
      {
        type: "custom_message",
        id: "goal-entry",
        timestamp: "1970-01-01T00:00:00.001Z",
        customType: marker.customType,
        content: marker.content,
        display: false,
        details: marker.details,
      },
      { type: "message", id: "assistant-entry", message: streaming },
    ];
    const fake = {
      messages: [marker, streaming],
      agent: { state: { streamingMessage: streaming as unknown } },
      sessionManager: { getLeafId: () => "assistant-entry", getBranch: () => branch },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    expect(
      snapshotMessages(session, undefined, undefined, undefined, undefined, true),
    ).toMatchObject([
      {
        id: "assistant-entry",
        goalLoopTurn: { goalId: "loop-1", turn: 2, kind: "goal" },
        parts: [{ type: "text", text: "ストリーミング中" }],
      },
    ]);
  });

  it("carries Goal Loop metadata to an appended streaming message", () => {
    const marker = {
      role: "custom",
      customType: "leafcode-goal-turn",
      content: "internal prompt",
      display: false,
      details: { goalId: "loop-1", turn: 2, kind: "goal" },
      timestamp: 1,
    };
    const branch = [
      {
        type: "custom_message",
        id: "goal-entry",
        timestamp: "1970-01-01T00:00:00.001Z",
        customType: marker.customType,
        content: marker.content,
        display: false,
        details: marker.details,
      },
    ];
    const fake = {
      messages: [],
      agent: { state: { streamingMessage: undefined as unknown } },
      sessionManager: { getLeafId: () => "goal-entry", getBranch: () => branch },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];
    snapshotMessages(session);

    fake.agent.state.streamingMessage = {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "追加ストリーム" }],
    };

    expect(
      snapshotMessages(session, undefined, undefined, undefined, undefined, true),
    ).toMatchObject([
      {
        goalLoopTurn: { goalId: "loop-1", turn: 2, kind: "goal" },
        parts: [{ type: "text", text: "追加ストリーム" }],
      },
    ]);
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

  it("retains the branch source while an in-history stream changes", () => {
    const streaming = {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "一" }],
    };
    const branch = [{ type: "message", id: "a1", message: streaming }];
    let branchReads = 0;
    const fake = {
      messages: [streaming],
      agent: { state: { streamingMessage: streaming as unknown } },
      sessionManager: {
        getLeafId: () => "a1",
        getBranch: () => {
          branchReads += 1;
          return branch;
        },
      },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    snapshotMessages(session);
    streaming.content[0]!.text = "二";
    expect(
      snapshotMessages(session, undefined, undefined, undefined, undefined, true),
    ).toMatchObject([{ parts: [{ type: "text", text: "二" }] }]);

    branchReads = 0;
    streaming.content[0]!.text = "三";
    expect(
      snapshotMessages(session, undefined, undefined, undefined, undefined, true),
    ).toMatchObject([{ parts: [{ type: "text", text: "三" }] }]);
    expect(branchReads).toBe(0);

    fake.agent.state.streamingMessage = undefined;
    expect(snapshotMessages(session)).toMatchObject([
      { parts: [{ type: "text", text: "三" }] },
    ]);
    expect(branchReads).toBe(0);
  });

  it("does not project older stored messages for an in-history delta", () => {
    const older = new Proxy<Record<string, unknown>>(
      {},
      {
        get(_target, property) {
          if (property === "role") throw new Error("older message projected");
          return undefined;
        },
      },
    );
    const streaming = {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "最新" }],
    };
    const stored: unknown[] = [older, streaming];
    const fake = {
      messages: stored,
      agent: { state: { streamingMessage: streaming as unknown } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    expect(
      snapshotMessages(session, undefined, undefined, undefined, undefined, true),
    ).toMatchObject([
      {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "最新" }],
      },
    ]);
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
