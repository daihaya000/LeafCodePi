import assert from "node:assert/strict";
import { test } from "node:test";
import { botCodeSessionCounts, botsWithCodeSessionCounts } from "./bot-session-counts.mjs";

const task = (overrides) => ({ id: "t", status: "working", ...overrides });

test("only working tasks count, for their Bot or their supervisor", () => {
  const counts = botCodeSessionCounts([
    task({ id: "t1", botId: "bot-1" }),
    task({ id: "t2", botId: "bot-1" }),
    task({ id: "t3", supervisorBotId: "bot-1" }),
    task({ id: "t4", status: "idle", botId: "bot-1" }),
    task({ id: "t5", status: "working" }),
    task({ id: "t6", status: "working", botId: null, supervisorBotId: null }),
  ]);
  assert.deepEqual(counts, { "bot-1": 3 });
});

test("a task with both ids counts for its own Bot only", () => {
  assert.deepEqual(botCodeSessionCounts([task({ botId: "bot-1", supervisorBotId: "bot-2" })]), { "bot-1": 1 });
});

test("an empty or unusable list yields no counts", () => {
  assert.deepEqual(botCodeSessionCounts([]), {});
  assert.deepEqual(botCodeSessionCounts(undefined), {});
  assert.deepEqual(botCodeSessionCounts(null), {});
  assert.deepEqual(botCodeSessionCounts([null, undefined, {}]), {});
});

test("the DTOs carry a count, defaulting to zero for an idle Bot", () => {
  const bots = [{ id: "bot-1", name: "busy" }, { id: "bot-2", name: "idle" }];
  assert.deepEqual(botsWithCodeSessionCounts(bots, [task({ botId: "bot-1" })]), [
    { id: "bot-1", name: "busy", codeSessionCount: 1 },
    { id: "bot-2", name: "idle", codeSessionCount: 0 },
  ]);
  assert.deepEqual(botsWithCodeSessionCounts(bots, []), [
    { id: "bot-1", name: "busy", codeSessionCount: 0 },
    { id: "bot-2", name: "idle", codeSessionCount: 0 },
  ]);
  assert.deepEqual(botsWithCodeSessionCounts(undefined, [task({ botId: "bot-1" })]), []);
  assert.deepEqual(botsWithCodeSessionCounts([], [task({ botId: "bot-1" })]), []);
});
