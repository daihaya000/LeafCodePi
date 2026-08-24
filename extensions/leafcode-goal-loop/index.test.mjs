import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractGoalResult,
  extractGoalResultFromMessages,
  jsonObjectCandidates,
  applyResult,
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

    const payload = Buffer.from(JSON.stringify({ goal: "new goal", maxTurns: 1 })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    const restarted = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "complete-session.json"), "utf8"),
    );
    assert.equal(restarted.goal, "new goal");
    assert.ok(restarted.status === "queued" || restarted.status === "running");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
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

test("waits for agent_end so tool turns do not stop the loop before the result JSON", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leafcode-goal-loop-live-"));
  const handlers = new Map();
  const commands = new Map();
  let busy = false;
  let turnIndex = 0;
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
    })).toString("base64url");
    await commands.get("goal-start")?.(payload, ctx);
    await new Promise((resolve) => setTimeout(resolve, 700));

    const loop = JSON.parse(
      readFileSync(join(cwd, ".pi", "goals-loop", "live-session.json"), "utf8"),
    );
    assert.equal(sendCount, 2);
    assert.equal(loop.status, "blocked");
    assert.equal(loop.progress[0].summary, "after tool");
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
