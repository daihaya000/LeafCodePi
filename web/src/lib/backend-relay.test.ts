import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backendRelayCompatible,
  relayBotList,
  relayFallbackAllowed,
  relayTaskRows,
  resetBackendRelayCompatibilityCache,
} from "./backend-relay";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("relayFallbackAllowed", () => {
  it("is only the owner's option: a client must report the miss", () => {
    expect(relayFallbackAllowed({})).toBe(true);
    expect(relayFallbackAllowed({ NODE_ENV: "production" })).toBe(false);
    // The Backend process itself is never blocked, even when it is the runtime host.
    expect(relayFallbackAllowed({ NODE_ENV: "production", LEAFCODE_PI_BACKEND_RUNTIME: "attach" })).toBe(true);
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

  it("stays out of the way while this process owns the runtime", async () => {
    const result = await relayTaskRows({ includeArchived: false, kind: "code", env: {}, fetchTasks: readTasks });
    expect(result).toBeNull();
    expect(readTasks).not.toHaveBeenCalled();
  });

  it("filters the Backend rows exactly like the store does", async () => {
    readTasks.mockResolvedValue({ ok: true, status: 200, body: { tasks: rows } });
    const env = { NODE_ENV: "production" };
    const code = await relayTaskRows({ includeArchived: false, kind: "code", env, fetchTasks: readTasks });
    expect(code?.map((row) => row.id)).toEqual(["code-1"]);
    const all = await relayTaskRows({ includeArchived: true, kind: "all", env, fetchTasks: readTasks });
    expect(all?.map((row) => row.id)).toEqual(["code-1", "code-2", "bot-1", "bot-2"]);
    const bots = await relayTaskRows({ includeArchived: false, kind: "bot", env, fetchTasks: readTasks });
    expect(bots?.map((row) => row.id)).toEqual(["bot-1"]);
  });

  it("returns null so the caller can fall back when the Backend cannot answer", async () => {
    const env = { NODE_ENV: "production" };
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

  it("stays out of the way while this process owns the runtime", async () => {
    const fetchBots = vi.fn();
    const result = await relayBotList({ env: {}, fetchBots, fetchTasks: vi.fn() });
    expect(result).toBeNull();
    expect(fetchBots).not.toHaveBeenCalled();
  });

  it("returns the Backend Bots with their running-session counts", async () => {
    const result = await relayBotList({
      env: { NODE_ENV: "production" },
      fetchBots: async () => ({ ok: true, status: 200, body: { bots } }),
      fetchTasks: async () => ({ ok: true, status: 200, body: { tasks } }),
    });
    expect(result).toEqual([
      { id: "bot-1", name: "busy", codeSessionCount: 1 },
      { id: "bot-2", name: "idle", codeSessionCount: 0 },
    ]);
  });

  it("returns null when either read fails, so the caller falls back", async () => {
    const env = { NODE_ENV: "production" };
    const ok = { ok: true as const, status: 200, body: { bots, tasks } };
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
      env: { NODE_ENV: "production" },
      fetchBots: vi.fn().mockResolvedValue({ ok: true, status: 200, body: {} }),
      fetchTasks: async () => ({ ok: true, status: 200, body: { tasks } }),
    });
    expect(result).toEqual([]);
  });
});

describe("generation compatibility", () => {
  beforeEach(() => resetBackendRelayCompatibilityCache());
  afterEach(() => resetBackendRelayCompatibilityCache());

  const env = { NODE_ENV: "production", LEAFCODE_PI_BACKEND_GENERATION: "gen-a" };
  const health = (generation: string | null) => async () => ({
    ok: true as const,
    status: 200,
    body: { ready: true, status: "ready", pid: 1, runtimeGeneration: generation },
  });

  it("accepts a Backend of the pinned generation and rejects another", async () => {
    expect(await backendRelayCompatible({ env, fetchHealth: health("gen-a") })).toBe(true);
    resetBackendRelayCompatibilityCache();
    expect(await backendRelayCompatible({ env, fetchHealth: health("gen-b") })).toBe(false);
    resetBackendRelayCompatibilityCache();
    expect(await backendRelayCompatible({ env, fetchHealth: health(null) })).toBe(false);
  });

  it("reuses the probe inside the window and re-probes after it", async () => {
    let clock = 1_000;
    const fetchHealth = vi.fn(health("gen-a"));
    const options = { env, fetchHealth, now: () => clock };
    expect(await backendRelayCompatible(options)).toBe(true);
    expect(await backendRelayCompatible(options)).toBe(true);
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    clock += 6_000;
    fetchHealth.mockImplementation(health("gen-b"));
    expect(await backendRelayCompatible(options)).toBe(false);
    expect(fetchHealth).toHaveBeenCalledTimes(2);
  });

  it("has nothing to compare without a pin, and stays off for the owner", async () => {
    const fetchHealth = vi.fn(health("gen-b"));
    expect(await backendRelayCompatible({ env: { NODE_ENV: "production" }, fetchHealth })).toBe(true);
    expect(fetchHealth).not.toHaveBeenCalled();
    // The owner serves its own store: no Backend read, not even a probe.
    expect(await backendRelayCompatible({ env: { LEAFCODE_PI_BACKEND_GENERATION: "gen-a" }, fetchHealth })).toBe(false);
    expect(fetchHealth).not.toHaveBeenCalled();
  });

  it("keeps the relay on the in-process path when the generation differs", async () => {
    const fetchTasks = vi.fn(async () => ({ ok: true as const, status: 200, body: { tasks: [] } }));
    expect(await relayTaskRows({
      includeArchived: true,
      kind: "all",
      env,
      fetchTasks,
      fetchHealth: health("gen-b"),
    })).toBeNull();
    expect(fetchTasks).not.toHaveBeenCalled();
    resetBackendRelayCompatibilityCache();
    expect(await relayBotList({ env, fetchBots: vi.fn(), fetchTasks: vi.fn(), fetchHealth: health("gen-b") })).toBeNull();
  });
});
