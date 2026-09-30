import { afterEach, describe, expect, it, vi } from "vitest";
import { isBackendRelayEnabled, relayBotList, relayTaskRows } from "./backend-relay";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isBackendRelayEnabled", () => {
  it("is off unless the environment explicitly turns it on", () => {
    for (const value of [undefined, "", "0", "false", "off", "no", "maybe"]) {
      expect(isBackendRelayEnabled({ LEAFCODE_PI_BACKEND_RELAY: value })).toBe(false);
    }
    for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(isBackendRelayEnabled({ LEAFCODE_PI_BACKEND_RELAY: value })).toBe(true);
    }
  });
});

describe("relayTaskRows", () => {
  const rows = [
    { id: "code-1", kind: "code", status: "idle" },
    { id: "code-2", status: "archived" },
    { id: "bot-1", kind: "bot", status: "idle" },
    { id: "bot-2", kind: "bot", status: "archived" },
  ];
  const readTasks = vi.fn();

  it("stays out of the way while the relay is off", async () => {
    const result = await relayTaskRows({ includeArchived: false, kind: "code", env: {}, fetchTasks: readTasks });
    expect(result).toBeNull();
    expect(readTasks).not.toHaveBeenCalled();
  });

  it("filters the Backend rows exactly like the store does", async () => {
    readTasks.mockResolvedValue({ ok: true, status: 200, body: { tasks: rows } });
    const env = { LEAFCODE_PI_BACKEND_RELAY: "1" };
    const code = await relayTaskRows({ includeArchived: false, kind: "code", env, fetchTasks: readTasks });
    expect(code?.map((row) => row.id)).toEqual(["code-1"]);
    const all = await relayTaskRows({ includeArchived: true, kind: "all", env, fetchTasks: readTasks });
    expect(all?.map((row) => row.id)).toEqual(["code-1", "code-2", "bot-1", "bot-2"]);
    const bots = await relayTaskRows({ includeArchived: false, kind: "bot", env, fetchTasks: readTasks });
    expect(bots?.map((row) => row.id)).toEqual(["bot-1"]);
  });

  it("returns null so the caller can fall back when the Backend cannot answer", async () => {
    const env = { LEAFCODE_PI_BACKEND_RELAY: "1" };
    for (const failure of [
      { ok: false, reason: "not-configured" },
      { ok: false, reason: "unreachable" },
      { ok: false, reason: "timeout" },
    ]) {
      readTasks.mockResolvedValue(failure);
      await expect(relayTaskRows({ includeArchived: false, kind: "code", env, fetchTasks: readTasks })).resolves.toBeNull();
    }
    readTasks.mockResolvedValue({ ok: true, status: 200, body: {} });
    await expect(relayTaskRows({ includeArchived: false, kind: "code", env, fetchTasks: readTasks })).resolves.toEqual([]);
  });
});

describe("relayBotList", () => {
  const bots = [{ id: "bot-1", name: "busy" }, { id: "bot-2", name: "idle" }];
  const tasks = [{ id: "t1", status: "working", botId: "bot-1" }];

  it("stays out of the way while the relay is off", async () => {
    const fetchBots = vi.fn();
    const result = await relayBotList({ env: {}, fetchBots, fetchTasks: vi.fn() });
    expect(result).toBeNull();
    expect(fetchBots).not.toHaveBeenCalled();
  });

  it("returns the Backend Bots with their running-session counts", async () => {
    const result = await relayBotList({
      env: { LEAFCODE_PI_BACKEND_RELAY: "1" },
      fetchBots: async () => ({ ok: true, status: 200, body: { bots } }),
      fetchTasks: async () => ({ ok: true, status: 200, body: { tasks } }),
    });
    expect(result).toEqual([
      { id: "bot-1", name: "busy", codeSessionCount: 1 },
      { id: "bot-2", name: "idle", codeSessionCount: 0 },
    ]);
  });

  it("returns null when either read fails, so the caller falls back", async () => {
    const env = { LEAFCODE_PI_BACKEND_RELAY: "1" };
    const ok = { ok: true, status: 200, body: { bots, tasks } };
    await expect(relayBotList({
      env,
      fetchBots: async () => ({ ok: false, reason: "unreachable" }),
      fetchTasks: async () => ok,
    })).resolves.toBeNull();
    await expect(relayBotList({
      env,
      fetchBots: async () => ({ ok: true, status: 200, body: { bots } }),
      fetchTasks: async () => ({ ok: false, reason: "timeout" }),
    })).resolves.toBeNull();
  });

  it("tolerates a payload without a Bot list", async () => {
    const result = await relayBotList({
      env: { LEAFCODE_PI_BACKEND_RELAY: "1" },
      fetchBots: async () => ({ ok: true, status: 200, body: {} }),
      fetchTasks: async () => ({ ok: true, status: 200, body: { tasks } }),
    });
    expect(result).toEqual([]);
  });
});
