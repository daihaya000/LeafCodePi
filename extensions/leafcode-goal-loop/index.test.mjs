import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractGoalResult,
  extractGoalResultFromMessages,
  jsonObjectCandidates,
  applyResult,
  applyMissingResult,
  buildGoalContinuationPrompt,
  buildVerificationPrompt,
  clampCooldownSeconds,
  clampMaxTurns,
  normalizeAcceptance,
  parseCooldownSeconds,
} from "./index.ts";
import goalLoopExtension from "./index.ts";

test("matches LeafCode turn-budget and cooldown normalization", () => {
  assert.equal(clampMaxTurns(0), 0);
  assert.equal(clampMaxTurns(101), 100);
  assert.equal(parseCooldownSeconds("15m 30s"), 930);
  assert.equal(clampCooldownSeconds(-1), 0);
});

test("extracts the last valid structured result", () => {
  const result = extractGoalResult(
    'ignored {"status":"progress","summary":"old"} {"status":"progress","summary":"new"}',
  );
  assert.equal(result?.summary, "new");
});

test("extracts the final result after tool-call assistant messages", () => {
  assert.equal(
    extractGoalResultFromMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: '{"status":"progress","summary":"after tool"}' }] },
    ])?.summary,
    "after tool",
  );
});

test("handles braces inside JSON strings", () => {
  assert.equal(
    jsonObjectCandidates('{"text":"}"}{"status":"blocked","summary":"stop"}').length,
    2,
  );
});

test("normalizes acceptance criteria", () => {
  assert.deepEqual(normalizeAcceptance("run tests\ncheck the diff"), ["run tests", "check the diff"]);
});

test("normal mode requires a verification turn", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 1,
      forceFullRun: false,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyResult(loop, { time: new Date().toISOString(), status: "completed", summary: "claimed" });
    assert.equal(loop.status, "verifying_completed");
    loop.status = "running";
    loop.turnKind = "verification";
    applyResult(loop, { time: new Date().toISOString(), status: "verified_completed", summary: "verified" });
    assert.equal(loop.status, "completed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("full-run ignores early completion and stops at the turn limit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 1,
      forceFullRun: true,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyResult(loop, { time: new Date().toISOString(), status: "completed", summary: "claimed" });
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "turn_limit");
    assert.equal(loop.progress[0].status, "progress");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("completes a turn-limited loop and allows a new loop", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-complete-"));
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    signal: undefined,
    sessionManager: {
      getSessionId: () => "complete-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: (message, level) => notices.push({ message, level }),
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {},
  };
  const loop = {
    id: "complete-session",
    sessionId: "complete-session",
    cwd,
    status: "running",
    goal: "old goal",
    acceptance: [],
    maxTurns: 1,
    cooldownSeconds: 0,
    nextTurnAt: null,
    forceFullRun: true,
    turnCount: 1,
    turnKind: "goal",
    pauseReason: "",
    error: "",
    progress: [],
    summary: "",
    evidence: "",
    blockedReason: "",
    rejectedClaims: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    applyResult(loop, { time: new Date().toISOString(), status: "completed", summary: "turn limit reached" });
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "turn_limit");

    await commands.get("goal-complete")?.("", ctx);
    const completed = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "complete-session.json"), "utf8"),
    );
    assert.equal(completed.status, "completed");
    assert.match(notices.at(-1).message, /新しい Goal loop/);

    const payload = Buffer.from(JSON.stringify({ goal: "new goal", maxTurns: 1, autoAgent: true })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    const restarted = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "complete-session.json"), "utf8"),
    );
    assert.equal(restarted.goal, "new goal");
    assert.equal(restarted.autoAgent, true);
    assert.ok(restarted.status === "queued" || restarted.status === "running");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("keeps the loop alive once when the result JSON is missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-missing-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 0,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: true,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      unreadableStreak: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyMissingResult(loop, "ToDo完了");
    assert.equal(loop.status, "queued");
    assert.equal(loop.unreadableStreak, 1);
    assert.equal(loop.progress.at(-1).summary, "ToDo完了");
    assert.match(buildGoalContinuationPrompt(loop, 2), /JSON result block/);

    applyMissingResult(loop, "");
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "unreadable_result");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("keeps a missing verification result in the verification phase", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-missing-verification-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 1,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: false,
      turnCount: 1,
      turnKind: "verification",
      pauseReason: "",
      error: "",
      progress: [{
        time: new Date().toISOString(),
        status: "completed",
        summary: "実装を完了した",
        evidence: "テスト成功",
      }],
      summary: "実装を完了した",
      evidence: "テスト成功",
      blockedReason: "",
      rejectedClaims: 0,
      unreadableStreak: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyMissingResult(loop, "検証結果を説明しました");
    assert.equal(loop.status, "verifying_completed");
    assert.equal(loop.turnKind, "verification");
    assert.equal(loop.unreadableStreak, 1);
    assert.match(buildVerificationPrompt(loop), /summary: 実装を完了した/);
    assert.doesNotMatch(buildVerificationPrompt(loop), /検証結果を説明しました/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resets the unreadable streak after a readable result", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-recover-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 0,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: true,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      unreadableStreak: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyResult(loop, { time: new Date().toISOString(), status: "progress", summary: "back on track" });
    assert.equal(loop.status, "queued");
    assert.equal(loop.unreadableStreak, 0);
    assert.equal(loop.pauseReason, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unlimited mode does not pause at zero", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 0,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: true,
      turnCount: 12,
      turnKind: "goal",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyResult(loop, { time: new Date().toISOString(), status: "progress", summary: "still working" });
    assert.equal(loop.status, "queued");
    assert.equal(loop.pauseReason, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("pauses after two rejected verification claims", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-"));
  try {
    const loop = {
      id: "session",
      sessionId: "session",
      cwd,
      status: "running",
      goal: "demo",
      acceptance: [],
      maxTurns: 10,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: false,
      turnCount: 2,
      turnKind: "verification",
      pauseReason: "",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyResult(loop, { time: new Date().toISOString(), status: "progress", summary: "not verified" });
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "verification_rejected");
    assert.equal(loop.rejectedClaims, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("retries queued work when agent_settled is delayed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-delayed-settled-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "delayed-settled-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      if (sendCount !== 1) return;
      busy = true;
      void (async () => {
        busy = false;
        await handlers.get("agent_end")?.({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ status: "progress", summary: "first turn" }) }],
          }],
        }, ctx);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      })();
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(sendCount, 2);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("waits for agent_end so tool turns do not stop the loop before the result JSON", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-live-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let turnIndex = 0;
  let sendCount = 0;
  let prepareCount = 0;
  const preparePrompts = [];

  const ctx = {
    cwd,
    mode: "rpc",
    prepareGoalLoopTurn: async (prompt) => {
      prepareCount += 1;
      preparePrompts.push(prompt);
      return true;
    },
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "live-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      const result = sendCount === 1
        ? { status: "progress", summary: "after tool" }
        : { status: "blocked", summary: "done", evidence: "test blocker" };
      const runMessages = sendCount === 1
        ? [
            { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] },
            { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
            { role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }] },
          ]
        : [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }] }];
      busy = true;
      void (async () => {
        const firstTurn = turnIndex++;
        await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: firstTurn }, ctx);
        await handlers.get("turn_end")?.({
          type: "turn_end",
          turnIndex: firstTurn,
          message: runMessages[0],
        }, ctx);
        if (sendCount === 1) {
          const finalTurn = turnIndex++;
          await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: finalTurn }, ctx);
          await handlers.get("turn_end")?.({
            type: "turn_end",
            turnIndex: finalTurn,
            message: runMessages[2],
          }, ctx);
        }
        busy = false;
        await handlers.get("agent_end")?.({ type: "agent_end", messages: runMessages }, ctx);
        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      })();
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({
      goal: "demo",
      maxTurns: 2,
      forceFullRun: true,
      autoAgent: true,
    })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const loop = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "live-session.json"), "utf8"),
    );
    assert.equal(sendCount, 2);
    assert.equal(prepareCount, 2);
    assert.equal(preparePrompts.length, 2);
    assert.match(preparePrompts[0], /Goal:\s+demo/);
    assert.match(preparePrompts[1], /Continue the persistent goal loop/);
    assert.equal(loop.autoAgent, true);
    assert.equal(loop.status, "blocked");
    assert.equal(loop.progress[0].summary, "after tool");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("retries a missing result on the final bounded turn without consuming another turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-missing-final-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "missing-final-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      busy = true;
      const text = sendCount === 1
        ? "作業は完了しました。"
        : JSON.stringify({ status: "progress", summary: "再試行で結果を返した" });
      void (async () => {
        busy = false;
        await handlers.get("agent_end")?.({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text }] }],
        }, ctx);
        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      })();
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({
      goal: "demo",
      maxTurns: 1,
      forceFullRun: true,
    })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const loop = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "missing-final-session.json"), "utf8"),
    );
    assert.equal(sendCount, 2);
    assert.equal(loop.turnCount, 1);
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "turn_limit");
    assert.equal(loop.unreadableStreak, 0);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("does not finalize before a compaction retry has fully settled", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-compaction-retry-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "compaction-retry-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      busy = true;
      void (async () => {
        await handlers.get("agent_end")?.({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ status: "progress", summary: "before compaction" }) }],
          }],
        }, ctx);
        // Automatic compaction retries inside the same agent run. The final
        // agent_end arrives only after the retry has produced its result.
        busy = false;
        await handlers.get("agent_end")?.({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ status: "blocked", summary: "finished" }) }],
          }],
        }, ctx);
        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      })();
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const loop = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "compaction-retry-session.json"), "utf8"),
    );
    assert.equal(sendCount, 1);
    assert.equal(loop.status, "blocked");
    assert.equal(loop.summary, "finished");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("requeues a Goal loop provider-limit turn when a fallback route is available", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-provider-fallback-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  let canRetryCount = 0;

  const ctx = {
    cwd,
    mode: "rpc",
    canRetryGoalLoopProviderLimit: async () => {
      canRetryCount += 1;
      return true;
    },
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "provider-fallback-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      busy = true;
      busy = false;
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 1 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await new Promise((resolve) => setTimeout(resolve, 400));

    await handlers.get("agent_end")?.({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached", content: [] }],
    }, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    const loop = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "provider-fallback-session.json"), "utf8"),
    );
    assert.equal(canRetryCount, 1);
    assert.equal(sendCount, 1);
    assert.equal(loop.status, "queued");
    assert.equal(loop.pauseReason, "");
    assert.equal(loop.turnCount, 0);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("pauses a Goal loop after a final provider error instead of scheduling another turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-provider-error-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "provider-error-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      busy = true;
      void (async () => {
        busy = false;
        await handlers.get("agent_end")?.({
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider failed", content: [] }],
        }, ctx);
        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      })();
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const loop = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "provider-error-session.json"), "utf8"),
    );
    assert.equal(sendCount, 1);
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "scheduler_error");
    assert.match(loop.error, /provider failed/);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("keeps a manually stopped loop terminal after the aborted run settles", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-stop-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "stop-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() { busy = true; },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await commands.get("goal-stop")?.("", ctx);
    await handlers.get("agent_end")?.({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
    }, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    const loop = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "stop-session.json"), "utf8"),
    );
    assert.equal(loop.status, "stopped");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor: 条件が成立しませんでした");
}

test("applies a result that lands after a turn_timeout pause instead of losing it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-turn-timeout-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, ".pi", "goals-loop", "turn-timeout-session.json");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "turn-timeout-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      busy = true;
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await waitFor(() => {
      const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
      return loop.status === "running";
    });

    await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, ctx);
    // 15分watchdogがタイマーで発火した状態を再現（turn_start後、結果確定前）。
    await commands.get("goal-pause")?.("", ctx);
    const paused = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "user");
    paused.pauseReason = "turn_timeout";
    writeFileSync(stateFile(), JSON.stringify(paused, null, 2), "utf8");

    // タイムアウト後もランは続いており、最後に正常な結果を返す。
    busy = false;
    await handlers.get("turn_end")?.({
      type: "turn_end",
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ status: "progress", summary: "late result" }) }],
      },
    }, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    const recovered = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(recovered.progress.at(-1).summary, "late result");
    assert.equal(recovered.status, "queued");
    await waitFor(() => sendCount === 2);
    const running = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(running.status, "running");
    assert.equal(running.turnCount, 2);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("plain resume at the turn budget is rejected and a raised limit resumes it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-budget-resume-"));
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, ".pi", "goals-loop", "budget-resume-session.json");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "budget-resume-session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: (message, level) => notices.push({ message, level }),
    },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      busy = true;
      void (async () => {
        busy = false;
        await handlers.get("agent_end")?.({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ status: "progress", summary: `turn ${sendCount}` }) }],
          }],
        }, ctx);
        await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      })();
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 1, forceFullRun: true })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await waitFor(() => {
      const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
      return loop.status === "paused" && loop.pauseReason === "turn_limit";
    });

    // 上限未指定の再開は拒否され、状態はpausedのまま。
    await commands.get("goal-resume")?.("", ctx);
    assert.match(notices.at(-1).message, /最大ターン数/);
    let loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(loop.status, "paused");
    assert.equal(sendCount, 1);

    // 上限を増やすと再開し、次のターンが送信される。
    await commands.get("goal-resume")?.("--turns 2", ctx);
    await waitFor(() => sendCount === 2);
    await waitFor(() => {
      const current = JSON.parse(readFileSync(stateFile(), "utf8"));
      return current.status === "paused" && current.pauseReason === "turn_limit";
    });
    loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(loop.maxTurns, 2);
    assert.equal(loop.turnCount, 2);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});
