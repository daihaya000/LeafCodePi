import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageScope } from "./types";

const state = vi.hoisted(() => ({
  config: vi.fn((): Record<string, unknown> => ({})),
  accounts: vi.fn((): { id: string; label: string; enabled: boolean; providers: string[] }[] => []),
  peer: vi.fn((): object | null => null),
  configured: vi.fn(() => true),
  fetch: vi.fn((): Promise<unknown> => Promise.resolve({})),
  create: vi.fn(),
}));
vi.mock("@/lib/accounts", () => ({
  listAccounts: state.accounts,
  isAccountEnabled: (account: { enabled: boolean }) => account.enabled !== false,
  accountHasProvider: (account: { providers: string[] }, provider: string) => account.providers.includes(provider),
  resolvePiAgentDir: async () => "C:/test/agent",
  accountDir: (id: string, dir: string) => `${dir}/accounts/${id}`,
  accountAuthPath: (id: string, dir: string) => `${dir}/accounts/${id}/auth.json`,
}));
vi.mock("@backend-core/peer-auth-config.mjs", () => ({ readPeerConfig: state.peer }));
vi.mock("./codexbar-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codexbar-config")>()),
  loadCodexBarConfig: state.config,
}));
vi.mock("./providers/openai-codex", () => ({ createOpenaiCodexProvider: state.create }));

import { checkCodexResetCredits, ensureCodexResetScheduler } from "./reset-scheduler";
const globals = globalThis as typeof globalThis & {
  __leafcodeCodexResetScheduler?: ReturnType<typeof setInterval>;
};
const account = (id: string, enabled = true) => ({ id, label: id, enabled, providers: ["openai-codex"] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  state.config.mockReset().mockReturnValue({});
  state.accounts.mockReturnValue([]);
  state.peer.mockReturnValue(null);
  state.configured.mockReturnValue(true);
  state.fetch.mockReset().mockResolvedValue({});
  state.create.mockReset().mockImplementation(() => ({ isConfigured: state.configured, fetch: state.fetch }));
});
afterEach(() => {
  if (globals.__leafcodeCodexResetScheduler) clearInterval(globals.__leafcodeCodexResetScheduler);
  delete globals.__leafcodeCodexResetScheduler;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("owner reset scheduler", () => {
  it("checks on startup and every minute without a browser, and starts only once", async () => {
    ensureCodexResetScheduler();
    ensureCodexResetScheduler();
    await checkCodexResetCredits();
    expect(state.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });

  it("respects OFF and resumes on the next tick after enabling without a restart", async () => {
    state.config.mockReturnValue({ codexResetAutoConsume: false });
    ensureCodexResetScheduler();
    await checkCodexResetCredits();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.fetch).not.toHaveBeenCalled();
    state.config.mockReturnValue({ codexResetAutoConsume: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.fetch).toHaveBeenCalledOnce();
  });

  it("checks enabled local Codex accounts, but skips paused, peer and other providers", async () => {
    state.accounts.mockReturnValue([account("active"), account("paused", false), account("shared"), { ...account("claude"), providers: ["anthropic"] }]);
    state.peer.mockImplementation((...args: unknown[]) => String(args[0]).endsWith("/shared") ? {} : null);
    await checkCodexResetCredits();
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: "account", accountId: "active", authPath: "C:/test/agent/accounts/active/auth.json",
    }));
  });

  it("does not bypass a paused account through default auth", async () => {
    state.accounts.mockReturnValue([account("paused", false)]);
    await checkCodexResetCredits();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("skips unconfigured authentication", async () => {
    state.configured.mockReturnValue(false);
    await checkCodexResetCredits();
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it("isolates account failures and retries on the next tick", async () => {
    state.accounts.mockReturnValue([account("first"), account("second")]);
    state.fetch.mockRejectedValueOnce(new Error("private token"));
    ensureCodexResetScheduler();
    await checkCodexResetCredits();
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith("[codex-auto-reset] account usage unavailable; retry on next check");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.fetch).toHaveBeenCalledTimes(4);
  });

  it("coalesces overlapping ticks and reloads account credentials for later ticks", async () => {
    let release!: () => void;
    state.fetch.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = checkCodexResetCredits();
    expect(checkCodexResetCredits()).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.fetch).toHaveBeenCalledOnce();
    release();
    await first;
    await checkCodexResetCredits();
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.create.mock.calls[1][0] as UsageScope).toMatchObject({ kind: "default" });
  });
});
