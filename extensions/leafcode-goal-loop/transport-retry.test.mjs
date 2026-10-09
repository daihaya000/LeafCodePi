import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import goalLoopExtension, { goalLoopTestSeams } from "./index.ts";

async function fixture(t, run) {
  const cwd = mkdtempSync(join(tmpdir(), "goal-transport-retry-"));
  const previous = process.env.LEAFCODE_PI_DATA_DIR;
  process.env.LEAFCODE_PI_DATA_DIR = cwd;
  const handlers = new Map();
  const commands = new Map();
  const id = "transport-test";
  const sent = [];
  let busy = false;
  const ctx = {
    cwd, mode: "rpc", hasUI: false,
    isIdle: () => !busy, hasPendingMessages: () => false,
    abort: () => { busy = false; },
    sessionManager: { getSessionId: () => id, getBranch: () => [] },
    ui: { setStatus() {}, setWidget() {}, notify() {} },
    canRetryGoalLoopProviderLimit: async () => false,
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options.handler); },
    appendEntry() {},
    sendMessage(message) {
      if (message.customType === "leafcode-goal-loop-ended") return;
      sent.push(message);
      busy = true;
    },
  };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const tick = async (ms) => { t.mock.timers.tick(ms); await flush(); };
  const state = () => JSON.parse(readFileSync(join(cwd, "goals-loop", `${id}.json`), "utf8"));
  const settle = async (message) => {
    busy = false;
    await handlers.get("agent_end")({ type: "agent_end", messages: [message] }, ctx);
    await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
  };
  const success = (status) => settle({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ status, summary: "done" }) }] });
  const fail = (errorMessage = "terminated", stopReason = "error") => settle({ role: "assistant", stopReason, errorMessage,
    content: [{ type: "toolCall", id: "incomplete", name: "codemode", arguments: { code: "text(await tools.write(" } }] });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  try {
    goalLoopExtension(pi);
    await handlers.get("session_start")({}, ctx);
    await commands.get("goal-start")(Buffer.from(JSON.stringify({ goal: "demo", maxTurns: 2, initialImages: [{ type: "image", mimeType: "image/png", data: "dGVzdA==" }] })).toString("base64url"), ctx);
    await tick(250);
    assert.equal(sent.length, 1);
    await run({ state, sent, tick, fail, success, settle, handlers, commands, ctx, pi });
  } finally {
    goalLoopTestSeams.setWriteLoopFail(false);
    await handlers.get("session_shutdown")?.({}, ctx);
    goalLoopTestSeams.disposeAllForTests();
    t.mock.timers.reset();
    if (previous === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const kind of ["goal", "unreadable", "verification"]) {
  test(`transport recovery preserves ${kind} turn budget and stop cancels backoff`, async (t) => fixture(t, async (f) => {
    if (kind !== "goal") {
      if (kind === "verification") await f.success("completed");
      else await f.settle({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "no JSON" }] });
      await f.tick(250);
    }
    const before = f.state();
    const sent = f.sent.length;
    await f.fail();
    assert.equal(f.state().status, kind === "verification" ? "verifying_completed" : "queued");
    assert.equal(f.state().turnCount, before.turnCount);
    assert.equal(f.state().unreadableStreak, before.unreadableStreak);
    assert.equal(f.state().retryInterruptedTurn, true);
    assert.equal(Date.parse(f.state().nextTurnAt) - Date.now(), 5_000);
    await f.tick(4_999);
    assert.equal(f.sent.length, sent);
    await f.tick(251);
    assert.equal(f.sent.length, sent + 1);
    assert.equal(f.state().turnCount, before.turnCount);
    assert.equal(typeof f.sent.at(-1).content, "string", "first-turn images are not replayed");
    await f.fail("fetch failed");
    assert.equal(Date.parse(f.state().nextTurnAt) - Date.now(), 10_000);
    await f.commands.get("goal-stop")("", f.ctx);
    await f.tick(300_000);
    assert.equal(f.sent.length, sent + 1);
    assert.equal(f.state().status, "stopped");
  }));
}

test("persistent transport failure pauses after five retries", async (t) => fixture(t, async (f) => {
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000]) {
    await f.fail();
    assert.equal(Date.parse(f.state().nextTurnAt) - Date.now(), delay);
    await f.tick(delay + 250);
    assert.equal(f.state().turnCount, 1);
  }
  assert.equal(f.sent.length, 6);
  await f.fail();
  assert.equal(f.state().status, "paused");
  assert.equal(f.state().pauseReason, "scheduler_error");
  assert.equal(f.state().error, "terminated");
  await f.tick(300_000);
  assert.equal(f.sent.length, 6);
}));

test("a successful result resets transport backoff", async (t) => fixture(t, async (f) => {
  await f.fail();
  await f.tick(5_250);
  await f.success("progress");
  await f.tick(250);
  assert.equal(f.state().turnCount, 2);
  await f.fail();
  assert.equal(Date.parse(f.state().nextTurnAt) - Date.now(), 5_000);
}));

for (const error of ["401 unauthorized", "Request was aborted", "provider failed"]) {
  test(`does not retry terminal error: ${error}`, async (t) => fixture(t, async (f) => {
    await f.fail(error);
    assert.equal(f.state().status, "paused");
    await f.tick(300_000);
    assert.equal(f.sent.length, 1);
  }));
}

test("user pause during backoff prevents delivery", async (t) => fixture(t, async (f) => {
  await f.fail();
  await f.commands.get("goal-pause")("", f.ctx);
  await f.tick(300_000);
  assert.equal(f.state().status, "paused");
  assert.equal(f.sent.length, 1);
}));

test("reload preserves transport retry delay and attempt count", async (t) => fixture(t, async (f) => {
  await f.fail();
  await f.handlers.get("session_shutdown")({ reason: "reload" }, f.ctx);
  goalLoopExtension(f.pi);
  await f.handlers.get("session_start")({ reason: "reload" }, f.ctx);
  await f.tick(4_999);
  assert.equal(f.sent.length, 1);
  await f.tick(251);
  assert.equal(f.sent.length, 2);
  await f.fail();
  assert.equal(Date.parse(f.state().nextTurnAt) - Date.now(), 10_000);
}));

test("native retries keep ownership until settlement and a recovered result wins", async (t) => fixture(t, async (f) => {
  await f.handlers.get("agent_end")({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error", errorMessage: "terminated", content: [] }] }, f.ctx);
  assert.equal(f.state().status, "running");
  assert.equal(f.sent.length, 1);
  await f.success("progress");
  await f.tick(250);
  assert.equal(f.state().turnCount, 2);
  assert.equal(f.sent.length, 2);
}));

test("failed retry-state persistence retains settlement evidence", async (t) => fixture(t, async (f) => {
  goalLoopTestSeams.setWriteLoopFail(true);
  await f.fail();
  assert.equal(f.state().status, "running");
  assert.equal(f.state().turnCount, 1);
  goalLoopTestSeams.setWriteLoopFail(false);
  await f.handlers.get("agent_settled")({}, f.ctx);
  assert.equal(f.state().status, "queued");
  assert.equal(Date.parse(f.state().nextTurnAt) - Date.now(), 5_000);
  await f.tick(5_250);
  assert.equal(f.sent.length, 2);
  assert.equal(f.state().turnCount, 1);
}));
