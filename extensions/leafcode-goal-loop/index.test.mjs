import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import goalLoopExtension, { goalLoopTestSeams } from "./index.ts";

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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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

    // Stale verification state must not let verified_completed finish a full-run.
    loop.status = "running";
    loop.turnKind = "verification";
    loop.pauseReason = "";
    loop.error = "";
    applyResult(loop, { time: new Date().toISOString(), status: "verified_completed", summary: "should stay progress" });
    assert.equal(loop.progress.at(-1).status, "progress");
    assert.notEqual(loop.status, "completed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("completeLoop rejects forged turn_limit before the budget is exhausted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-complete-forged-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const stateFile = () => join(cwd, "goals-loop", "complete-forged-session.json");
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    sessionManager: { getSessionId: () => "complete-forged-session", getBranch: () => [] },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: (message, level) => notices.push({ message, level }),
    },
  };

  try {
    goalLoopExtension({
      on(name, handler) { handlers.set(name, handler); },
      registerCommand(name, options) { commands.set(name, options.handler); },
      appendEntry() {},
      sendMessage() {},
    });
    await handlers.get("session_start")?.({}, ctx);
    mkdirSync(join(cwd, "goals-loop"), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({
      goal: "demo",
      status: "paused",
      pauseReason: "turn_limit",
      turnCount: 1,
      maxTurns: 5,
      forceFullRun: true,
      turnKind: "goal",
      acceptance: [],
      progress: [],
      unreadableStreak: 0,
      pendingTurnRecovery: false,
    }), "utf8");

    await commands.get("goal-complete")?.("", ctx);
    const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "turn_limit");
    assert.match(notices.at(-1).message, /最大ターン数に到達した一時停止中/);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("completes a turn-limited loop and allows a new loop", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-complete-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
      readFileSync(join(cwd, "goals-loop", "complete-session.json"), "utf8"),
    );
    assert.equal(completed.status, "completed");
    assert.match(notices.at(-1).message, /新しい Goal loop/);

    const payload = Buffer.from(JSON.stringify({ goal: "new goal", maxTurns: 1, autoAgent: true })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    const restarted = JSON.parse(
      readFileSync(join(cwd, "goals-loop", "complete-session.json"), "utf8"),
    );
    assert.equal(restarted.goal, "new goal");
    assert.equal(restarted.autoAgent, true);
    assert.ok(restarted.status === "queued" || restarted.status === "running");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeLoop retries transient rename failures and cleans temp on fallback", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-write-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const goalsDir = join(cwd, "goals-loop");
  const loop = {
    id: "write-session",
    sessionId: "write-session",
    cwd,
    status: "queued",
    goal: "demo",
    acceptance: [],
    maxTurns: 1,
    cooldownSeconds: 0,
    nextTurnAt: null,
    forceFullRun: true,
    turnCount: 0,
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

  try {
    let attempts = 0;
    goalLoopTestSeams.setRenameSync((temp, file) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("locked");
        err.code = "EPERM";
        throw err;
      }
      writeFileSync(file, readFileSync(temp, "utf8"), "utf8");
      rmSync(temp, { force: true });
    });
    applyResult(loop, { time: new Date().toISOString(), status: "progress", summary: "after retry" });
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(readFileSync(join(goalsDir, "write-session.json"), "utf8")).summary, "after retry");
    assert.equal(readdirSync(goalsDir).some((name) => name.endsWith(".tmp")), false);

    attempts = 0;
    goalLoopTestSeams.setRenameSync(() => {
      attempts += 1;
      const err = new Error("still locked");
      err.code = "EBUSY";
      throw err;
    });
    applyResult(loop, { time: new Date().toISOString(), status: "progress", summary: "fallback write" });
    assert.equal(attempts, 5);
    assert.equal(JSON.parse(readFileSync(join(goalsDir, "write-session.json"), "utf8")).summary, "fallback write");
    assert.equal(readdirSync(goalsDir).some((name) => name.endsWith(".tmp")), false);
    assert.equal(existsSync(join(goalsDir, "write-session.json")), true);
  } finally {
    goalLoopTestSeams.setRenameSync();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("recovers a torn state file from the newest valid temp snapshot", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-corrupt-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, "goals-loop", "corrupt-session.json");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "corrupt-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
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
    mkdirSync(join(cwd, "goals-loop"), { recursive: true });
    const snapshot = {
      goal: "recover me",
      status: "queued",
      turnKind: "goal",
      turnCount: 0,
      maxTurns: 2,
      cooldownSeconds: 0,
      nextTurnAt: "not-a-date",
      forceFullRun: true,
      acceptance: [],
      progress: [],
      unreadableStreak: 0,
    };
    writeFileSync(`${stateFile()}.1.1.tmp`, JSON.stringify(snapshot), "utf8");
    writeFileSync(stateFile(), "{\"goal\":\"torn", "utf8"); // truncated JSON

    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    await waitFor(() => sendCount === 1);

    const recovered = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(recovered.goal, "recover me");
    assert.equal(recovered.nextTurnAt, null);
    assert.equal(recovered.status, "running");
    assert.equal(readdirSync(join(cwd, "goals-loop")).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("keeps the loop alive once when the result JSON is missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-missing-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let turnIndex = 0;
  let sendCount = 0;
  let prepareCount = 0;
  const preparePrompts = [];
  const sentMessages = [];

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
    sendMessage(message) {
      sentMessages.push(message);
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
      readFileSync(join(cwd, "goals-loop", "live-session.json"), "utf8"),
    );
    assert.equal(sendCount, 2);
    assert.equal(prepareCount, 2);
    assert.equal(preparePrompts.length, 2);
    assert.match(preparePrompts[0], /Goal:\s+demo/);
    assert.match(preparePrompts[1], /Continue the persistent goal loop/);
    assert.equal(sentMessages[0].display, false);
    assert.equal(sentMessages[0].details.uiPrompt, "demo");
    assert.match(sentMessages[0].content, /<!-- webui-goal-loop-prompt -->/);
    assert.equal(sentMessages[1].display, false);
    assert.equal(sentMessages[1].details.uiPrompt, undefined);
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
      readFileSync(join(cwd, "goals-loop", "missing-final-session.json"), "utf8"),
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

test("resume after unreadable_result at the turn limit allows one JSON retry", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-unreadable-resume-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, "goals-loop", "unreadable-resume-session.json");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "unreadable-resume-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() {
      sendCount += 1;
      busy = true;
      const text = sendCount <= 2
        ? "結果JSONを付け忘れました。"
        : JSON.stringify({ status: "progress", summary: `recovered ${sendCount}` });
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
    await waitFor(() => {
      const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
      return loop.status === "paused" && loop.pauseReason === "unreadable_result";
    });
    let loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(sendCount, 2);
    assert.equal(loop.turnCount, 1);
    assert.equal(loop.unreadableStreak, 2);

    // Budget is exhausted, but the pause was for missing JSON — resume must
    // still allow the non-consuming formatting retry.
    await commands.get("goal-resume")?.("", ctx);
    await waitFor(() => sendCount === 3);
    await waitFor(() => {
      const current = JSON.parse(readFileSync(stateFile(), "utf8"));
      return current.status === "paused" && current.pauseReason === "turn_limit";
    });
    loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(loop.turnCount, 1);
    assert.equal(loop.unreadableStreak, 0);
    assert.equal(loop.progress.at(-1)?.summary, "recovered 3");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("does not finalize before a compaction retry has fully settled", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-compaction-retry-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
      readFileSync(join(cwd, "goals-loop", "compaction-retry-session.json"), "utf8"),
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
      readFileSync(join(cwd, "goals-loop", "provider-fallback-session.json"), "utf8"),
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
      readFileSync(join(cwd, "goals-loop", "provider-error-session.json"), "utf8"),
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
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
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
      readFileSync(join(cwd, "goals-loop", "stop-session.json"), "utf8"),
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

test("manual_send keeps a late result without auto-continuing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-manual-send-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, "goals-loop", "manual-send-session.json");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "manual-send-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
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
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 3 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await waitFor(() => sendCount === 1);

    await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, ctx);
    await handlers.get("input")?.({ text: "手動で割り込む", source: "user" }, ctx);
    const paused = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "manual_send");

    // Abort settlement can finish before turn_end; the late JSON must be kept
    // without scheduling the next Goal turn past the user's interrupt.
    busy = false;
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await handlers.get("turn_end")?.({
      type: "turn_end",
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ status: "progress", summary: "late after manual send" }) }],
      },
    }, ctx);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(loop.progress.at(-1)?.summary, "late after manual send");
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "manual_send");
    assert.equal(sendCount, 1);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("applies a result that lands after a turn_timeout pause instead of losing it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-turn-timeout-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, "goals-loop", "turn-timeout-session.json");

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

    // Settlement can finish while paused; a later turn_end still carries the
    // result. Do not rely on a second agent_settled to re-arm the scheduler.
    busy = false;
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await handlers.get("turn_end")?.({
      type: "turn_end",
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ status: "progress", summary: "late result" }) }],
      },
    }, ctx);

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

test("resume recovers a late transcript result and schedules the next turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-resume-late-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, "goals-loop", "resume-late-session.json");
  const branch = [];

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "resume-late-session",
      getBranch: () => branch,
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
    sendMessage(message) {
      sendCount += 1;
      busy = true;
      branch.push({
        type: "custom_message",
        customType: message.customType,
        details: message.details,
        content: message.content,
      });
    },
  };

  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 3 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await waitFor(() => {
      const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
      return loop.status === "running" && sendCount === 1;
    });

    await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, ctx);
    await commands.get("goal-pause")?.("", ctx);
    const paused = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "user");

    // Settlement already happened: the assistant JSON is in the transcript, but
    // turn_end/agent_settled will not fire again. Resume must recover and arm.
    busy = false;
    branch.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ status: "progress", summary: "recovered on resume" }) }],
      },
    });

    await commands.get("goal-resume")?.("", ctx);
    const recovered = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(recovered.progress.at(-1)?.summary, "recovered on resume");
    assert.equal(recovered.status, "queued");

    await waitFor(() => sendCount === 2);
    const continued = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(continued.status, "running");
    assert.equal(continued.turnCount, 2);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("plain resume at the turn budget is rejected and a raised limit resumes it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-budget-resume-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, "goals-loop", "budget-resume-session.json");

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

test("stops a replaced runtime from double-sending queued work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-replaced-"));
  const stateFile = () => join(cwd, "goals-loop", "replaced-session.json");
  const makeEnv = () => ({
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "replaced-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
  });
  const makePi = () => ({
    handlers: new Map(),
    commands: new Map(),
    on(name, handler) { this.handlers.set(name, handler); },
    registerCommand(name, options) { this.commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() { sendCount += 1; busy = true; },
  });
  const instances = [];
  let busy = true;
  let sendCount = 0;

  try {
    process.env.LEAFCODE_PI_DATA_DIR = cwd;
    // 旧ランタイム（A）をqueuedで待機させ、その後にセッション置換相当で新ラン
    // タイム（B）を同一キーで登録する。Aが持ち続けたタイマーは送信してはならない。
    const piA = makePi();
    goalLoopExtension(piA);
    const ctxA = makeEnv();
    instances.push({ pi: piA, ctx: ctxA });
    await piA.handlers.get("session_start")?.({}, ctxA);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 2 })).toString("base64url");
    await piA.commands.get("goal-start")?.(payload, ctxA);

    const piB = makePi();
    goalLoopExtension(piB);
    const ctxB = makeEnv();
    instances.push({ pi: piB, ctx: ctxB });
    await piB.handlers.get("session_start")?.({}, ctxB);

    busy = false;
    await waitFor(() => sendCount === 1);
    await piB.commands.get("goal-stop")?.("", ctxB);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(sendCount, 1);
    const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(loop.status, "stopped");
  } finally {
    for (const { pi, ctx } of instances) {
      await pi.handlers.get("session_shutdown")?.({}, ctx);
    }
    delete process.env.LEAFCODE_PI_DATA_DIR;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ignores a stale turn_timeout after dispose-less session replacement", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-stale-timeout-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  goalLoopTestSeams.setTurnTimeoutMs(40);
  const stateFile = () => join(cwd, "goals-loop", "stale-timeout-session.json");
  const makeEnv = () => ({
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "stale-timeout-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
  });
  const makePi = () => ({
    handlers: new Map(),
    commands: new Map(),
    on(name, handler) { this.handlers.set(name, handler); },
    registerCommand(name, options) { this.commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage() { sendCount += 1; busy = true; },
  });
  const instances = [];
  let busy = false;
  let sendCount = 0;

  try {
    const piA = makePi();
    goalLoopExtension(piA);
    const ctxA = makeEnv();
    instances.push({ pi: piA, ctx: ctxA });
    await piA.handlers.get("session_start")?.({}, ctxA);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 3 })).toString("base64url");
    await piA.commands.get("goal-start")?.(payload, ctxA);
    await waitFor(() => sendCount === 1);
    assert.equal(JSON.parse(readFileSync(stateFile(), "utf8")).status, "running");
    // Keep A's already-armed short watchdog, but do not let B's later watchdog
    // fire during this race window.
    goalLoopTestSeams.setTurnTimeoutMs(60_000);

    // dispose() without session_shutdown: A keeps its watchdog, B owns the key.
    const piB = makePi();
    goalLoopExtension(piB);
    const ctxB = makeEnv();
    instances.push({ pi: piB, ctx: ctxB });
    await piB.handlers.get("session_start")?.({}, ctxB);
    const paused = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "");

    busy = false;
    await piB.commands.get("goal-resume")?.("", ctxB);
    await waitFor(() => {
      const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
      return loop.status === "running" && sendCount === 2;
    });

    // A's stale watchdog must not pause B's resumed turn.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(loop.status, "running");
    assert.notEqual(loop.pauseReason, "turn_timeout");
    assert.equal(sendCount, 2);
  } finally {
    goalLoopTestSeams.setTurnTimeoutMs();
    for (const { pi, ctx } of instances) {
      await pi.handlers.get("session_shutdown")?.({}, ctx);
    }
    delete process.env.LEAFCODE_PI_DATA_DIR;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continues pending verification after a session replacement without a user pause", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-verification-replace-"));
  const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
  const stateFile = join(cwd, "goals-loop", "verification-replace-session.json");
  const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const sent = [];
  let busy = false;
  const makeSession = () => {
    const handlers = new Map();
    const commands = new Map();
    const ctx = {
      cwd,
      mode: "rpc",
      hasUI: false,
      isIdle: () => !busy,
      hasPendingMessages: () => false,
      abort: () => { busy = false; },
      sessionManager: {
        getSessionId: () => "verification-replace-session",
        getBranch: () => [],
      },
      ui: { setStatus() {}, setWidget() {}, notify() {} },
    };
    goalLoopExtension({
      on(name, handler) { handlers.set(name, handler); },
      registerCommand(name, options) { commands.set(name, options.handler); },
      appendEntry() {},
      sendMessage(message) { sent.push(message); busy = true; },
    });
    return { ctx, handlers, commands };
  };
  const first = makeSession();
  const replacement = makeSession();
  first.ctx.prepareGoalLoopTurn = async () => {
    if (readState().status !== "verifying_completed") return true;
    // The harness reopens the transcript when routing to a different account/agent.
    await replacement.handlers.get("session_start")({}, replacement.ctx);
    return false;
  };
  const settle = async (session, status) => {
    busy = false;
    await session.handlers.get("agent_end")({
      messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ status, summary: status }) }] }],
    }, session.ctx);
    await session.handlers.get("agent_settled")({}, session.ctx);
  };

  try {
    process.env.LEAFCODE_PI_DATA_DIR = cwd;
    await first.handlers.get("session_start")({}, first.ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 1 })).toString("base64url");
    await first.commands.get("goal-start")(payload, first.ctx);
    await waitFor(() => sent.length === 1);
    await settle(first, "completed");
    assert.equal(readState().status, "verifying_completed");

    await waitFor(() => sent.length === 2 || readState().status === "paused");
    assert.equal(readState().status, "running");
    assert.equal(readState().pauseReason, "");
    assert.equal(readState().turnCount, 1);
    assert.equal(sent[1].customType, "leafcode-goal-verification");
    assert.match(sent[1].content, /Independently verify/);
    assert.equal(sent[1].details.uiPrompt, undefined);
    await settle(replacement, "verified_completed");
    assert.equal(readState().status, "completed");
    assert.deepEqual(readState().progress.map((entry) => entry.status), ["completed", "verified_completed"]);
    assert.equal(sent.length, 2);
  } finally {
    await first.handlers.get("session_shutdown")({}, first.ctx);
    await replacement.handlers.get("session_shutdown")({}, replacement.ctx);
    if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_shutdown mid-turn recovers via durable pendingTurnRecovery after reload", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-shutdown-recover-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const stateFile = () => join(cwd, "goals-loop", "shutdown-recover-session.json");
  const branch = [];
  let busy = false;
  let sendCount = 0;

  const makeEnv = () => ({
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "shutdown-recover-session",
      getBranch: () => branch,
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
  });
  const makePi = () => ({
    handlers: new Map(),
    commands: new Map(),
    on(name, handler) { this.handlers.set(name, handler); },
    registerCommand(name, options) { this.commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage(message) {
      sendCount += 1;
      busy = true;
      branch.push({
        type: "custom_message",
        customType: message.customType,
        details: message.details,
        content: message.content,
      });
    },
  });

  try {
    const piA = makePi();
    const ctxA = makeEnv();
    goalLoopExtension(piA);
    await piA.handlers.get("session_start")?.({}, ctxA);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 3 })).toString("base64url");
    await piA.commands.get("goal-start")?.(payload, ctxA);
    await waitFor(() => sendCount === 1);

    // Assistant finished, but settlement never applied before shutdown.
    branch.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ status: "progress", summary: "settled after shutdown" }) }],
      },
    });
    await piA.handlers.get("session_shutdown")?.({}, ctxA);
    const shutdown = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(shutdown.status, "paused");
    assert.equal(shutdown.pauseReason, "");
    assert.equal(shutdown.pendingTurnRecovery, true);
    assert.equal(shutdown.turnCount, 1);

    // Fresh runtime (dispose without keeping pausedTurnPending).
    const piB = makePi();
    const ctxB = makeEnv();
    goalLoopExtension(piB);
    await piB.handlers.get("session_start")?.({}, ctxB);
    const reloaded = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(reloaded.status, "paused");
    assert.equal(reloaded.pendingTurnRecovery, true);

    busy = false;
    await piB.commands.get("goal-resume")?.("", ctxB);
    await waitFor(() => {
      const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
      return loop.progress.at(-1)?.summary === "settled after shutdown";
    });
    const recovered = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(recovered.pendingTurnRecovery, false);
    assert.equal(recovered.turnCount, 1);
    // Must not re-send the interrupted turn; only continue to the next one.
    await waitFor(() => sendCount === 2);
    assert.equal(JSON.parse(readFileSync(stateFile(), "utf8")).turnCount, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("lifecycle resume keeps an absolute cooldown instead of sending early", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-lifecycle-cooldown-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const stateFile = () => join(cwd, "goals-loop", "lifecycle-cooldown-session.json");
  const handlers = new Map();
  const commands = new Map();
  let sendCount = 0;
  const nextTurnAt = new Date(Date.now() + 60_000).toISOString();

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    sessionManager: {
      getSessionId: () => "lifecycle-cooldown-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
  };

  try {
    mkdirSync(join(cwd, "goals-loop"), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({
      goal: "demo",
      status: "queued",
      turnKind: "goal",
      turnCount: 1,
      maxTurns: 0,
      forceFullRun: true,
      cooldownSeconds: 60,
      nextTurnAt,
      pauseReason: "",
      acceptance: [],
      progress: [],
      unreadableStreak: 0,
      pendingTurnRecovery: false,
    }), "utf8");

    goalLoopExtension({
      on(name, handler) { handlers.set(name, handler); },
      registerCommand(name, options) { commands.set(name, options.handler); },
      appendEntry() {},
      sendMessage() { sendCount += 1; },
    });

    await handlers.get("session_start")?.({}, ctx);
    assert.equal(JSON.parse(readFileSync(stateFile(), "utf8")).status, "queued");
    await handlers.get("session_shutdown")?.({}, ctx);

    const paused = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "");
    assert.equal(paused.nextTurnAt, nextTurnAt);
    assert.equal(paused.maxTurns, 0);

    // Fresh runtime after restart.
    const handlersB = new Map();
    const commandsB = new Map();
    goalLoopExtension({
      on(name, handler) { handlersB.set(name, handler); },
      registerCommand(name, options) { commandsB.set(name, options.handler); },
      appendEntry() {},
      sendMessage() { sendCount += 1; },
    });
    await handlersB.get("session_start")?.({}, ctx);
    await commandsB.get("goal-resume")?.("", ctx);

    const resumed = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.nextTurnAt, nextTurnAt);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sendCount, 0);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("preserves queued cooldowns and distinguishes lifecycle pauses from user pauses", async (t) => {
  for (const status of ["queued", "verifying_completed", "running", "paused"]) {
    await t.test(status, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-lifecycle-"));
      const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
      const stateFile = join(cwd, "goals-loop", "lifecycle-session.json");
      const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
      const handlers = new Map();
      const ctx = {
        cwd,
        mode: "rpc",
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: { getSessionId: () => "lifecycle-session", getBranch: () => [] },
        ui: { setStatus() {}, setWidget() {} },
      };
      const nextTurnAt = new Date(Date.now() + 60_000).toISOString();
      let sendCount = 0;
      try {
        process.env.LEAFCODE_PI_DATA_DIR = cwd;
        mkdirSync(join(cwd, "goals-loop"));
        writeFileSync(stateFile, JSON.stringify({
          goal: "demo", status, turnKind: "verification", turnCount: 1, maxTurns: 1,
          cooldownSeconds: 60, nextTurnAt, pauseReason: status === "paused" ? "user" : "",
        }), "utf8");
        goalLoopExtension({
          on(name, handler) { handlers.set(name, handler); },
          registerCommand() {},
          appendEntry() {},
          sendMessage() { sendCount += 1; },
        });
        await handlers.get("session_start")({}, ctx);
        const loop = readState();
        assert.equal(loop.status, status === "running" ? "paused" : status);
        assert.equal(loop.pauseReason, status === "paused" ? "user" : "");
        assert.equal(loop.nextTurnAt, nextTurnAt);
        if (status === "running") assert.match(loop.error, /セッション再開時/);
        // Let the scheduler run: a restored absolute cooldown must not be bypassed.
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(sendCount, 0);
        await handlers.get("session_shutdown")({}, ctx);
        const stopped = readState();
        assert.equal(stopped.status, "paused");
        assert.equal(stopped.pauseReason, status === "paused" ? "user" : "");
        if (status === "queued" || status === "verifying_completed") {
          assert.match(stopped.error, /セッション終了時/);
        }
      } finally {
        await handlers.get("session_shutdown")?.({}, ctx);
        if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
        else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

test("prepareGoalLoopTurn errors after startLoop do not pause the replacement", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-prepare-stale-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  let prepareCalls = 0;
  let releasePrepare;
  const prepareGate = new Promise((resolve) => { releasePrepare = resolve; });
  const stateFile = () => join(cwd, "goals-loop", "prepare-stale-session.json");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "prepare-stale-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
    prepareGoalLoopTurn: async () => {
      prepareCalls += 1;
      if (prepareCalls === 1) {
        await prepareGate;
        throw new Error("stale prepare failed");
      }
      return true;
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
    const first = Buffer.from(JSON.stringify({ goal: "first", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(first, ctx);
    await waitFor(() => prepareCalls === 1);

    // Replace the loop while the first prepare is still awaiting.
    const second = Buffer.from(JSON.stringify({ goal: "second", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(second, ctx);
    const replaced = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(replaced.goal, "second");
    assert.equal(replaced.status, "queued");

    releasePrepare();
    await waitFor(() => sendCount === 1);
    const running = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(running.goal, "second");
    assert.equal(running.status, "running");
    assert.notEqual(running.pauseReason, "scheduler_error");
    assert.equal(String(running.error).includes("stale prepare failed"), false);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("provider-limit retry after startLoop does not mutate the replacement", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-provider-stale-"));
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  let releaseRetry;
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  const stateFile = () => join(cwd, "goals-loop", "provider-stale-session.json");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "provider-stale-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
    canRetryGoalLoopProviderLimit: async () => {
      await retryGate;
      return true;
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
    const first = Buffer.from(JSON.stringify({ goal: "first", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(first, ctx);
    await waitFor(() => sendCount === 1);

    await handlers.get("agent_end")?.({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached", content: [] }],
    }, ctx);
    const settled = handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    // Replace the goal while canRetry is still awaiting.
    const second = Buffer.from(JSON.stringify({ goal: "second", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(second, ctx);
    const replaced = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(replaced.goal, "second");
    assert.equal(replaced.status, "queued");
    assert.equal(replaced.turnCount, 0);

    busy = false;
    releaseRetry();
    await settled;
    await waitFor(() => sendCount === 2);

    const running = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(running.goal, "second");
    assert.equal(running.status, "running");
    assert.equal(running.turnCount, 1);
    assert.equal(running.pauseReason, "");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("does not requeue a provider-limit retry after the loop was paused meanwhile", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-pause-race-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let sendCount = 0;
  const stateFile = () => join(cwd, "goals-loop", "pause-race-session.json");

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort: () => { busy = false; },
    signal: undefined,
    sessionManager: {
      getSessionId: () => "pause-race-session",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
    canRetryGoalLoopProviderLimit: async () => {
      // 再評価の待ち時間中にユーザーが一時停止した状況を再現する。
      await commands.get("goal-pause")?.("", ctx);
      return true;
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
    process.env.LEAFCODE_PI_DATA_DIR = cwd;
    goalLoopExtension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const payload = Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 2 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await waitFor(() => sendCount === 1);
    await waitFor(() => {
      const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
      return loop.status === "paused" && loop.pauseReason === "user";
    });
    // await後の書き戻しでqueuedに戻って再送信されてはならない。
    await new Promise((resolve) => setTimeout(resolve, 600));
    const loop = JSON.parse(readFileSync(stateFile(), "utf8"));
    assert.equal(loop.status, "paused");
    assert.equal(loop.pauseReason, "user");
    assert.equal(sendCount, 1);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    delete process.env.LEAFCODE_PI_DATA_DIR;
    rmSync(cwd, { recursive: true, force: true });
  }
});
