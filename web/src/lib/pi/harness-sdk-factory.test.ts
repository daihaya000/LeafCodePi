import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkRuntimeFactory } from "@backend-core/sdk-runtime.mjs";
import { writePeerConfig } from "@backend-core/peer-auth-config.mjs";
import { __resetPiAgentDirCacheForTests, accountAuthPath, accountDir, accountModelsStorePath, createAccount } from "@/lib/accounts";
import { getHealth, getRuntimeFor } from "./harness";

const hooks = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@/lib/pi/llama-provider", async (original) => ({
  ...await original<typeof import("./llama-provider")>(),
  registerLlamaProviders: hooks.register,
}));

const key = "__leafcodePiHarness";
const globals = globalThis as Record<string, unknown>;
let root: string;

function runtime() {
  return {
    getProvider: (id: string) => ({ id }),
    getProviders: () => [],
    registerProvider: () => undefined,
  };
}

function install(create: ReturnType<typeof vi.fn>) {
  const state = {
    pi: { ModelRuntime: { create } },
    sdkFactory: null,
    modelRuntime: null,
    accountRuntimes: null,
    initError: null,
    initPromise: null,
    live: new Map(),
    events: new EventEmitter(),
    watchdogRegistered: true,
    healthCache: null,
    modelCache: { at: Date.now(), value: [] },
    lastProviderSyncWarnings: [],
  };
  globals[key] = state;
  return state;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-sdk-factory-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  __resetPiAgentDirCacheForTests();
  hooks.register.mockReset();
  hooks.register.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
});

afterEach(() => {
  delete globals[key];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetPiAgentDirCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("harness SDK factory connection", () => {
  it("coalesces default initialization and publishes runtime only after registration", async () => {
    let finish!: () => void;
    hooks.register.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const value = runtime();
    const create = vi.fn(async () => value);
    const state = install(create);
    const factoryCall = vi.spyOn(SdkRuntimeFactory.prototype, "createModelRuntime");
    const first = getHealth();
    const second = getHealth();
    await vi.waitFor(() => expect(hooks.register).toHaveBeenCalledTimes(1));
    expect(state.modelRuntime).toBeNull();
    expect(await getRuntimeFor()).toBeNull();
    finish();
    const results = await Promise.all([first, second]);
    expect(results.map((health) => health.ok)).toEqual([true, true]);
    expect(state.modelRuntime).toBe(value);
    expect(factoryCall).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledExactlyOnceWith({ allowModelNetwork: true, modelRefreshTimeoutMs: 8_000 });
    expect(state.sdkFactory).toBeInstanceOf(SdkRuntimeFactory);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries registration failure without retaining a partially initialized default runtime", async () => {
    hooks.register.mockRejectedValueOnce(new Error("provider setup failed"));
    const value = runtime();
    const create = vi.fn(async () => value);
    const state = install(create);
    const failed = await getHealth();
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("provider setup failed");
    expect(state.modelRuntime).toBeNull();
    expect(state.initPromise).toBeNull();
    state.healthCache = null;
    const retried = await getHealth();
    expect(retried.ok).toBe(true);
    expect(state.modelRuntime).toBe(value);
    expect(create).toHaveBeenCalledTimes(2);
    expect(hooks.register).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps account paths isolated and deduplicates same-account creation through the factory", async () => {
    const first = createAccount({ label: "first", providers: ["openai-codex"] });
    const second = createAccount({ label: "second", providers: ["openai-codex"] });
    const create = vi.fn(async () => runtime());
    const state = install(create);
    const factoryCall = vi.spyOn(SdkRuntimeFactory.prototype, "createModelRuntime");
    const [a, again, b] = await Promise.all([
      getRuntimeFor(first.id), getRuntimeFor(first.id), getRuntimeFor(second.id),
    ]);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(state.modelRuntime).toBeNull();
    expect(factoryCall).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    for (const account of [first, second]) {
      expect(create).toHaveBeenCalledWith({
        authPath: accountAuthPath(account.id, join(root, "agent")),
        modelsStorePath: accountModelsStorePath(account.id, join(root, "agent")),
        allowModelNetwork: true,
        modelRefreshTimeoutMs: 8_000,
      });
    }
    expect(hooks.register).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives a peer account a remote credential store and no authPath, leaving other accounts file-backed", async () => {
    const peer = createAccount({ label: "peer", providers: ["anthropic"] });
    const local = createAccount({ label: "local", providers: ["anthropic"] });
    writePeerConfig(accountDir(peer.id, join(root, "agent")), {
      peerUrl: "http://100.64.0.2:3000", peerAccountId: null, providers: ["anthropic"], token: "p".repeat(43),
    });
    const create = vi.fn(async (_options: Record<string, unknown> & { credentials?: object }) => runtime());
    install(create as unknown as ReturnType<typeof vi.fn>);
    await Promise.all([getRuntimeFor(peer.id), getRuntimeFor(local.id)]);
    const [peerOptions] = create.mock.calls.find(([options]) => "credentials" in options)!;
    expect(peerOptions).not.toHaveProperty("authPath");
    expect(peerOptions).toMatchObject({
      modelsStorePath: accountModelsStorePath(peer.id, join(root, "agent")),
      allowModelNetwork: true,
      modelRefreshTimeoutMs: 8_000,
    });
    expect(Object.keys(peerOptions.credentials!).sort()).toEqual(["delete", "list", "modify", "read"]);
    expect(create).toHaveBeenCalledWith({
      authPath: accountAuthPath(local.id, join(root, "agent")),
      modelsStorePath: accountModelsStorePath(local.id, join(root, "agent")),
      allowModelNetwork: true,
      modelRefreshTimeoutMs: 8_000,
    });
    // Constructing the store must not contact the sharing LCP.
    expect(fetch).not.toHaveBeenCalled();
  });
});
