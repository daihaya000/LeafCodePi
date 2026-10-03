import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePeerConfig } from "@backend-core/peer-auth-config.mjs";
import { accountDir } from "@/lib/accounts";
import { watchPeerAvailability } from "./account-runtime-options";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "leafcode-peer-watch-"));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(agentDir, { recursive: true, force: true });
});

function peerAccount(id: string, providers: string[]) {
  writePeerConfig(accountDir(id, agentDir), {
    peerUrl: "http://100.64.0.2:3000", peerAccountId: "a1", providers, token: "p".repeat(43),
  });
}

function fakeRuntime(readyAfterRefreshes: number) {
  let refreshes = 0;
  return {
    refresh: vi.fn(async () => { refreshes += 1; }),
    hasConfiguredAuth: vi.fn(() => refreshes >= readyAfterRefreshes),
  };
}

describe("watchPeerAvailability", () => {
  it("retries the credential check with backoff until the shared providers are configured", async () => {
    peerAccount("acc", ["openai-codex"]);
    const runtime = fakeRuntime(2);
    const onRepaired = vi.fn();
    watchPeerAvailability(runtime, "acc", agentDir, onRepaired, [100, 200, 300]);
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
    expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: false });
    expect(onRepaired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(runtime.refresh).toHaveBeenCalledTimes(2);
    expect(onRepaired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a runtime that is already configured or an ordinary account", async () => {
    peerAccount("ready", ["openai-codex"]);
    const ready = fakeRuntime(0);
    watchPeerAvailability(ready, "ready", agentDir, vi.fn(), [100]);
    const local = fakeRuntime(99);
    watchPeerAvailability(local, "local", agentDir, vi.fn(), [100]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ready.refresh).not.toHaveBeenCalled();
    expect(local.refresh).not.toHaveBeenCalled();
  });

  it("gives up after the last delay and survives refresh failures", async () => {
    peerAccount("down", ["anthropic"]);
    const runtime = { refresh: vi.fn(async () => { throw new Error("offline"); }), hasConfiguredAuth: vi.fn(() => false) };
    const onRepaired = vi.fn();
    watchPeerAvailability(runtime, "down", agentDir, onRepaired, [100, 100]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.refresh).toHaveBeenCalledTimes(2);
    expect(onRepaired).not.toHaveBeenCalled();
  });
});
