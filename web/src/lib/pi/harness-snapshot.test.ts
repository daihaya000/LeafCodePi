import { describe, expect, it, vi } from "vitest";
import {
  applyMessageAccountIds,
  applyMessageAgentIds,
  buildTaskBootstrap,
  sessionContextUsage,
  snapshotMessages,
} from "./harness";
import type { TaskSummary, UiMessage } from "@/lib/types";

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

  it("reuses finalized throughput rows across cached snapshots and observes in-place timing updates", () => {
    const stored: unknown[] = [{
      role: "assistant", timestamp: 1_000, content: [{ type: "text", text: "done" }],
    }];
    const session = {
      messages: stored,
      agent: { state: { streamingMessage: undefined } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    } as unknown as Parameters<typeof snapshotMessages>[0];
    const timing = {
      startedAtMs: 1_000, firstTokenAtMs: 1_500, lastTokenAtMs: 10_500,
      outputTokens: 100, charCount: 0,
    };
    const timings = new Map([[1_000, timing]]);

    const first = snapshotMessages(session, timings);
    const second = snapshotMessages(session, timings);
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
    timing.outputTokens = 200;
    const changed = snapshotMessages(session, timings);
    expect(changed).not.toBe(first);
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0]?.outputTokens).toBe(200);

    timings.delete(1_000);
    timings.set(2_000, { ...timing, startedAtMs: 2_000 });
    const unmatched = snapshotMessages(session, timings);
    expect(unmatched).not.toBe(changed);
    expect(unmatched[0]?.outputTokens).toBeUndefined();
  });

  it("reuses the latest-only array while the cached last message stays unchanged", () => {
    const stored: unknown[] = [
      { role: "user", content: "start" },
      { role: "assistant", timestamp: 1_000, content: [{ type: "text", text: "first" }] },
    ];
    const session = {
      messages: stored,
      agent: { state: { streamingMessage: undefined } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    } as unknown as Parameters<typeof snapshotMessages>[0];
    const timings = new Map([[1_000, {
      startedAtMs: 1_000, firstTokenAtMs: 1_500, lastTokenAtMs: 10_500,
      outputTokens: 100, charCount: 0,
    }]]);
    const latest = () => snapshotMessages(session, timings, undefined, undefined, undefined, true);

    const first = latest();
    expect(first).toHaveLength(1);
    expect(latest()).toBe(first);
    timings.get(1_000)!.outputTokens = 200;
    const updated = latest();
    expect(updated).not.toBe(first);
    expect(updated[0]?.outputTokens).toBe(200);

    stored.push({ role: "assistant", timestamp: 2_000, content: [{ type: "text", text: "next" }] });
    const changed = latest();
    expect(changed).not.toBe(updated);
    expect(changed[0]?.parts[0]).toMatchObject({ text: "next" });
  });

  it("reuses a tool row while its cumulative partial output is unchanged", () => {
    const stored: unknown[] = [{
      role: "assistant", timestamp: 1_000,
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
    }];
    const session = {
      messages: stored,
      agent: { state: { streamingMessage: undefined } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    } as unknown as Parameters<typeof snapshotMessages>[0];
    const output = new Map([["call-1", "first"]]);
    const snapshot = () => snapshotMessages(session, undefined, undefined, undefined, output);

    const first = snapshot();
    expect(first[0]?.parts[0]).toMatchObject({ state: { output: "first" } });
    const second = snapshot();
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
    output.set("call-1", "first\nsecond");
    const changed = snapshot();
    expect(changed).not.toBe(first);
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0]?.parts[0]).toMatchObject({ state: { output: "first\nsecond" } });

    output.delete("call-1");
    output.set("unmatched", "other");
    const unmatched = snapshot();
    expect(unmatched).not.toBe(changed);
    expect(unmatched[0]?.parts[0]).not.toHaveProperty("state.output");
  });

  it("reuses a tool row while its start and end timing is unchanged", () => {
    const stored: unknown[] = [{
      role: "assistant", timestamp: 1_000,
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
    }];
    const session = {
      messages: stored,
      agent: { state: { streamingMessage: undefined } },
      sessionManager: { getLeafId: () => null, getBranch: () => [] },
    } as unknown as Parameters<typeof snapshotMessages>[0];
    const started = new Map([["call-1", 1_000]]);
    const ended = new Map<string, number>();
    const snapshot = () => snapshotMessages(session, undefined, started, ended);

    const first = snapshot();
    expect(first[0]?.parts[0]).toMatchObject({ state: { startedAtMs: 1_000 } });
    expect(snapshot()[0]).toBe(first[0]);
    ended.set("call-1", 3_000);
    const changed = snapshot();
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0]?.parts[0]).toMatchObject({ state: { endedAtMs: 3_000 } });

    started.delete("call-1");
    started.set("unmatched", 4_000);
    const unmatched = snapshot();
    expect(unmatched[0]).not.toBe(changed[0]);
    expect(unmatched[0]?.parts[0]).not.toHaveProperty("state.startedAtMs");
  });

  it("skips stored-history membership checks when no message is streaming", () => {
    const stored: unknown[] = [{ role: "user", content: "idle" }];
    const includes = vi.spyOn(stored, "includes");
    try {
      const session = {
        messages: stored,
        agent: { state: { streamingMessage: undefined } },
        sessionManager: { getLeafId: () => null, getBranch: () => [] },
      } as unknown as Parameters<typeof snapshotMessages>[0];

      expect(snapshotMessages(session)).toHaveLength(1);
      expect(includes).not.toHaveBeenCalled();
    } finally {
      includes.mockRestore();
    }
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

  it("skips default-account remapping only when no message has a recorded account", () => {
    const messages: UiMessage[] = [{ id: "a", role: "assistant", createdAt: 1, parts: [] }];
    const context = { accountId: null, byMessageId: new Map<string, string>() };
    const map = vi.spyOn(messages, "map");
    try {
      expect(applyMessageAccountIds(messages, context)).toBe(messages);
      expect(map).not.toHaveBeenCalled();
      context.byMessageId.set("a", "acc-1");
      expect(applyMessageAccountIds(messages, context)[0]?.accountId).toBe("acc-1");
    } finally {
      map.mockRestore();
    }
  });

  it("reuses recorded-account rows and copies the list only for a new account", () => {
    const recorded: UiMessage = { id: "a", role: "assistant", createdAt: 1, parts: [], accountId: "old" };
    const fresh: UiMessage = { id: "b", role: "assistant", createdAt: 2, parts: [] };
    const messages = [recorded, fresh];
    const context = { accountId: "new", byMessageId: new Map([["a", "old"]]) };

    const updated = applyMessageAccountIds(messages, context);
    expect(updated).not.toBe(messages);
    expect(updated[0]).toBe(recorded);
    expect(updated[1]?.accountId).toBe("new");
    expect(context.byMessageId.get("b")).toBe("new");
    expect(applyMessageAccountIds(updated, context)).toBe(updated);
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

  it("reuses matching agent rows and copies the list only for a changed agent", () => {
    const recorded: UiMessage = { id: "a", role: "assistant", createdAt: 1, parts: [], agent: "builder" };
    const fresh: UiMessage = { id: "b", role: "assistant", createdAt: 2, parts: [] };
    const messages = [recorded, fresh];
    const context = {
      accountId: null,
      byMessageId: new Map<string, string>(),
      agentByMessageId: new Map<string, string | null>([["a", "builder"], ["b", "planner"]]),
    };

    const updated = applyMessageAgentIds(messages, context);
    expect(updated).not.toBe(messages);
    expect(updated[0]).toBe(recorded);
    expect(updated[1]?.agent).toBe("planner");
    expect(applyMessageAgentIds(updated, context)).toBe(updated);
  });

  it("keeps a recorded default persona after the current agent changes", () => {
    const messages: UiMessage[] = [{ id: "default", role: "assistant", createdAt: 1, parts: [] }];
    const agentByMessageId = new Map<string, string | null>();
    const context = { accountId: null, byMessageId: new Map<string, string>(), agentByMessageId };

    expect(applyMessageAgentIds(messages, context)).toBe(messages);
    expect(agentByMessageId.has("default")).toBe(true);
    expect(agentByMessageId.get("default")).toBeNull();
    expect(applyMessageAgentIds(messages, { ...context, agentName: "builder" })).toBe(messages);
    expect(agentByMessageId.get("default")).toBeNull();
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
      { accountId: null, byMessageId: new Map(), agentName: "builder", agentByMessageId },
    );
    expect(first.find((message) => message.role === "assistant")?.agent).toBe("builder");

    // Composerで役職を変更しても、既存メッセージは生成時の役職を維持する。
    const second = snapshotMessages(
      session,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { accountId: null, byMessageId: new Map(), agentName: "planner", agentByMessageId },
    );
    expect(second.find((message) => message.role === "assistant")?.agent).toBe("builder");
  });

  it("projects agent-switch boundaries for archived transcripts", () => {
    const stored: unknown[] = [
      { role: "user", content: "最初" },
      { role: "assistant", content: [{ type: "text", text: "build の回答" }] },
      {
        role: "custom",
        customType: "leafcode-pi.agent-switch",
        content: "[Session notice] persona switched",
        details: { previousAgent: "builder", nextAgent: "planner" },
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
    expect(assistants.map((message) => message.agent)).toEqual(["builder", "planner"]);
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

  it("aligns branch entry ids across hidden markers and tool results", () => {
    const branch = [
      { type: "message", id: "u1", message: { role: "user", content: "first" } },
      {
        type: "custom_message", id: "switch", customType: "leafcode-pi.agent-switch",
        timestamp: "1970-01-01T00:00:00.001Z", content: "switched",
        details: { previousAgent: "builder", nextAgent: "planner" },
      },
      { type: "custom_message", id: "ignored", customType: "unrelated", timestamp: "1970-01-01T00:00:00.002Z", content: "hidden" },
      { type: "message", id: "a1", message: { role: "assistant", content: [
        { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      ] } },
      { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] } },
      { type: "message", id: "u2", message: { role: "user", content: "next" } },
    ];
    const session = {
      messages: [],
      agent: { state: { streamingMessage: undefined } },
      sessionManager: { getLeafId: () => "u2", getBranch: () => branch },
    } as unknown as Parameters<typeof snapshotMessages>[0];

    const projected = snapshotMessages(session);
    expect(projected.map((item) => item.id)).toEqual(["u1", "a1", "u2"]);
    expect(projected[1]?.parts[0]?.id).toBe("msg-2-tool-call-1");
    expect(projected[1]?.agent).toBe("planner");
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

  it("keeps intercom metadata on latest-only projections", () => {
    const marker = {
      role: "custom",
      customType: "intercom_message",
      content: "hidden intercom context",
      display: true,
      details: { from: { id: "alice-session", name: "Alice" } },
      timestamp: 1,
    };
    const streaming = {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "内線を確認しました" }],
    };
    const branch = [
      {
        type: "custom_message",
        id: "intercom-entry",
        timestamp: "1970-01-01T00:00:00.001Z",
        customType: marker.customType,
        content: marker.content,
        display: marker.display,
        details: marker.details,
      },
    ];
    const fake = {
      messages: [marker, streaming],
      agent: { state: { streamingMessage: streaming as unknown } },
      sessionManager: { getLeafId: () => "intercom-entry", getBranch: () => branch },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    expect(
      snapshotMessages(session, undefined, undefined, undefined, undefined, true),
    ).toMatchObject([
      { id: "msg-1", intercom: { from: "Alice" } },
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

  it("reuses a full projection patched by a latest-only in-history delta", () => {
    const older = { role: "user", timestamp: 1, content: "確認して" };
    const streaming = {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "一" }],
    };
    const branch = [
      { type: "message", id: "u1", message: older },
      { type: "message", id: "a1", message: streaming },
    ];
    const fake = {
      messages: [older, streaming],
      agent: { state: { streamingMessage: streaming as unknown } },
      sessionManager: { getLeafId: () => "a1", getBranch: () => branch },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    const first = snapshotMessages(session);
    streaming.content[0]!.text = "二";
    expect(
      snapshotMessages(session, undefined, undefined, undefined, undefined, true),
    ).toMatchObject([{ parts: [{ type: "text", text: "二" }] }]);

    const full = snapshotMessages(session);
    expect(full.at(-1)?.parts[0]).toMatchObject({ text: "二" });
    expect(full[0]).toBe(first[0]);
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

  it("replaces a cloned in-history stream instead of appending a duplicate", () => {
    const branchMessage = {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "一" }],
    };
    const streaming = {
      ...branchMessage,
      content: [{ type: "text", text: "二" }],
    };
    const branch = [{ type: "message", id: "a1", message: branchMessage }];
    const fake = {
      messages: [branchMessage],
      agent: { state: { streamingMessage: streaming as unknown } },
      sessionManager: { getLeafId: () => "a1", getBranch: () => branch },
    };
    const session = fake as unknown as Parameters<typeof snapshotMessages>[0];

    expect(snapshotMessages(session)).toMatchObject([
      {
        id: "a1",
        parts: [{ type: "text", text: "二" }],
      },
    ]);
    expect(snapshotMessages(session)).toHaveLength(1);
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
