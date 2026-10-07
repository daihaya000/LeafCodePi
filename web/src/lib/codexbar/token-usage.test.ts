import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexBarProvider, CodexBarUsage } from "@/lib/codexbar";
import { attachTokenUsage, recordAssistantTokenUsage } from "./token-usage";

const NOW = Date.parse("2026-10-07T10:35:00Z");
let dir: string;
let sequence = 0;
function snapshot(percent = 10, at = NOW, extra: Partial<CodexBarProvider> = {}): CodexBarUsage {
  return { available: true, reason: null, schema: null, generatedAt: null, subscriptionTotalMonthlyUsd: null,
    providers: [{ id: "openai-codex", accountId: "a", opencodeId: "openai", plan: "Pro", planMonthlyUsd: null,
      usedPercent: percent, limited: false, maxed: false, error: null, stale: false,
      resetsAt: new Date(NOW + 3600_000).toISOString(), updatedAt: new Date(at).toISOString(), credits: null,
      windows: [{ id: "5h", title: "5時間", usedPercent: percent, resetsAt: new Date(NOW + 3600_000).toISOString(), windowMinutes: 300 }],
      ...extra }],
  };
}
function record(at = NOW + 1_000, account = "a", provider = "openai-codex", model = "gpt-test", tokens = 1000) {
  return recordAssistantTokenUsage("session", account, { role: "assistant", timestamp: ++sequence, provider, model,
    stopReason: "toolUse", usage: { input: tokens - 300, output: 100, cacheRead: 150, cacheWrite: 50, totalTokens: tokens, reasoning: 20, cacheWrite1h: 50 } }, at);
}
function measured(value: CodexBarUsage, now = NOW + 60_000) {
  return attachTokenUsage(value, now).providers[0].tokenUsage!;
}
function estimate(percent = 12, at = NOW + 2_000, extra: Partial<CodexBarProvider> = {}) {
  return measured(snapshot(percent, at, extra)).windows[0];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codexbar-token-test-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", dir);
  vi.spyOn(Date, "now").mockReturnValue(NOW + 60_000);
  sequence = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("actual token accounting", () => {
  it("counts input/output/caches once, including tool calls, and persists across reopen", () => {
    expect(record()).toBe(true);
    expect(measured(snapshot())).toMatchObject({ input: 700, output: 100, cacheRead: 150, cacheWrite: 50, totalTokens: 1000, responses: 1 });
    expect(measured(snapshot()).totalTokens).toBe(1000);
  });

  it("deduplicates final events and provider response IDs across sessions", () => {
    const m = { role: "assistant", timestamp: 1, provider: "anthropic", model: "sonnet", responseId: "r1", stopReason: "stop", usage: { totalTokens: 30 } };
    expect(recordAssistantTokenUsage("s", "a", m, NOW)).toBe(true);
    expect(recordAssistantTokenUsage("s", "a", m, NOW)).toBe(false);
    expect(recordAssistantTokenUsage("fork", "a", m, NOW)).toBe(false);
    expect(recordAssistantTokenUsage("s", "b", m, NOW)).toBe(true);
    expect(measured(snapshot(10, NOW, { id: "anthropic" })).totalTokens).toBe(30);
  });

  it("does not lose concurrent Backend/BFF writes or count duplicate responses twice", async () => {
    const bundle = join(dir, "store.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("./token-usage.ts", import.meta.url))], outfile: bundle,
      bundle: true, platform: "node", format: "esm",
      alias: { "@": fileURLToPath(new URL("../../", import.meta.url)), "@backend-core": fileURLToPath(new URL("../../../../backend/core", import.meta.url)) } });
    const workers = [0, 1, 2].map((worker) => new Promise<void>((resolve, reject) => {
      const code = `import {recordAssistantTokenUsage} from ${JSON.stringify(pathToFileURL(bundle).href)};
        for (let i=0; i<20; i++) {
          const m={role:"assistant",provider:"openai-codex",model:"gpt",timestamp:i,stopReason:"stop",responseId:"${worker}-"+i,usage:{totalTokens:1000}};
          if (!recordAssistantTokenUsage("s${worker}","a",m,${NOW + 1000})) process.exit(1);
          if (recordAssistantTokenUsage("fork${worker}","a",m,${NOW + 1000})) process.exit(2);
        }`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, LEAFCODE_PI_DATA_DIR: dir }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += String(data); });
      child.on("error", reject);
      child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(`worker ${worker}: ${status} ${stderr}`)));
    }));
    await Promise.all(workers);
    expect(measured(snapshot())).toMatchObject({ totalTokens: 60000, responses: 60 });
  });

  it("isolates providers/accounts/default scope and normalizes Cursor", () => {
    record(); record(NOW, "b"); record(NOW, "a", "commandcode"); record(NOW, "a", "cursor-acp");
    expect(measured(snapshot()).totalTokens).toBe(1000);
    expect(measured(snapshot(10, NOW, { accountId: "b" })).totalTokens).toBe(1000);
    expect(measured(snapshot(10, NOW, { accountId: null })).totalTokens).toBe(0);
    expect(measured(snapshot(10, NOW, { id: "cursor" })).totalTokens).toBe(1000);
    expect(measured(snapshot(10, NOW, { id: "commandcode" })).totalTokens).toBe(1000);
  });

  it("ignores partial, missing, invalid, zero and unsupported usage", () => {
    const m = { role: "assistant", timestamp: 1, provider: "openai-codex", model: "gpt", usage: { totalTokens: 100 } };
    for (const stopReason of ["pending", "aborted", "error", "deferred"]) {
      expect(recordAssistantTokenUsage("s", "a", { ...m, stopReason })).toBe(false);
    }
    expect(recordAssistantTokenUsage("", "a", { ...m, stopReason: "stop" })).toBe(false);
    expect(recordAssistantTokenUsage("s", "a", { ...m, timestamp: NaN, stopReason: "stop" })).toBe(false);
    expect(recordAssistantTokenUsage("s", "a", { ...m, usage: { totalTokens: Infinity }, stopReason: "stop" })).toBe(false);
    expect(record(NOW, "a", "openai")).toBe(false); // API usage must not leak into legacy Codex quota.
  });

  it.each(["opencode-go", "commandcode", "anthropic", "openai-codex"])("supports % provider %s", (provider) => {
    record(NOW, "a", provider);
    expect(measured(snapshot(10, NOW, { id: provider })).totalTokens).toBe(1000);
  });
});

describe("percent calibration", () => {
  it("derives per-percent and remaining tokens independently for each window", () => {
    const value = snapshot();
    value.providers[0].windows.push({ ...value.providers[0].windows[0], id: "week", title: "週間", usedPercent: 40, windowMinutes: 10080 });
    measured(value);
    record();
    const next = snapshot(12, NOW + 2_000);
    next.providers[0].windows.push({ ...value.providers[0].windows[1], usedPercent: 41 });
    const result = measured(next);
    expect(result.windows[0]).toMatchObject({ tokensPerPercent: 500, estimatedRemainingTokens: 44000, sampledTokens: 1000, sampledPercent: 2 });
    expect(result.windows[1]).toMatchObject({ tokensPerPercent: 1000, estimatedRemainingTokens: 59000 });
    expect(value.providers[0].windows).toHaveLength(2); // Cached snapshot remains untouched.
  });

  it("requires a percent-point and accumulates through rounded/lagged unchanged polls", () => {
    measured(snapshot()); record();
    expect(estimate(10, NOW + 2_000).tokensPerPercent).toBeNull();
    record(NOW + 3_000);
    expect(estimate(10.5, NOW + 4_000).tokensPerPercent).toBeNull();
    expect(estimate(12, NOW + 5_000).tokensPerPercent).toBe(1000);
  });

  it("does not absorb tokens after a cached snapshot, including repeated/older polls", () => {
    measured(snapshot()); record();
    expect(estimate().tokensPerPercent).toBe(500);
    record(NOW + 3_000);
    expect(estimate().tokensPerPercent).toBe(500);
    expect(estimate(11, NOW + 1_500).tokensPerPercent).toBeNull();
    expect(estimate(14, NOW + 4_000).tokensPerPercent).toBe(500);
  });

  it("holds the calibrated rate while usage is unchanged, then absorbs delayed percent updates", () => {
    measured(snapshot()); record(); expect(estimate().tokensPerPercent).toBe(500);
    record(NOW + 3000);
    expect(estimate(12, NOW + 4000).tokensPerPercent).toBe(500);
    expect(estimate(14, NOW + 5000).tokensPerPercent).toBe(500);
  });

  it("calibrates a percent update after earlier unreflected token usage", () => {
    measured(snapshot()); record();
    expect(estimate(10, NOW + 2000).tokensPerPercent).toBeNull();
    expect(estimate(12, NOW + 3000).tokensPerPercent).toBe(500);
  });

  it("never attributes tokens predating the baseline to a percent delta", () => {
    record(NOW - 1000); measured(snapshot()); record();
    expect(estimate().sampledTokens).toBe(1000);
  });

  it.each(["reset", "plan", "decrease"])("recalibrates after %s", (change) => {
    measured(snapshot()); record(); expect(estimate().tokensPerPercent).toBe(500);
    const next = snapshot(change === "decrease" ? 1 : 13, NOW + 3_000);
    if (change === "plan") next.providers[0].plan = "Max";
    if (change === "reset") next.providers[0].windows[0].resetsAt = new Date(NOW + 7200_000).toISOString();
    expect(measured(next).windows[0].tokensPerPercent).toBeNull();
  });

  it("invalidates a percent increase without any local measured tokens", () => {
    measured(snapshot()); record(); expect(estimate().tokensPerPercent).toBe(500);
    expect(estimate(13, NOW + 3_000).tokensPerPercent).toBeNull();
    record(NOW + 4_000);
    expect(estimate(15, NOW + 5_000).tokensPerPercent).toBe(500);
  });

  it("does not calibrate stale/display-only/breakdown/expired/future data", () => {
    measured(snapshot()); record(); estimate();
    for (const extra of [{ stale: true }, { usageDisplayOnly: true }] as Partial<CodexBarProvider>[]) {
      expect(estimate(12, NOW + 2_000, extra).tokensPerPercent).toBeNull();
    }
    const expired = snapshot(12, NOW + 2_000);
    expired.providers[0].windows[0].resetsAt = new Date(NOW - 1).toISOString();
    expect(measured(expired).windows[0].tokensPerPercent).toBeNull();
    expired.providers[0].windows[0].resetsAt = null;
    expired.providers[0].windows[0].countsTowardLimit = false;
    expect(measured(expired).windows[0].tokensPerPercent).toBeNull();
    expect(estimate(13, NOW + 120_000).tokensPerPercent).toBeNull();
  });

  it("freezes calibration at 100% and never reports negative remaining tokens", () => {
    measured(snapshot(98)); record();
    expect(estimate(100).estimatedRemainingTokens).toBe(0);
    record(NOW + 3_000);
    expect(estimate(100, NOW + 4_000).tokensPerPercent).toBe(500);
    expect(estimate(101, NOW + 5_000).estimatedRemainingTokens).toBeNull();
  });

  it("uses only matching Claude models for Sonnet/Opus sublimits", () => {
    const value = snapshot(10, NOW, { id: "anthropic" });
    value.providers[0].windows[0].id = "claude-weekly-sonnet";
    measured(value);
    record(NOW + 1000, "a", "anthropic", "claude-sonnet-4", 1000);
    record(NOW + 1000, "a", "anthropic", "claude-opus-4", 5000);
    const next = snapshot(12, NOW + 2000, { id: "anthropic" });
    next.providers[0].windows[0].id = "claude-weekly-sonnet";
    expect(measured(next).windows[0].tokensPerPercent).toBe(500);
    expect(measured(next).totalTokens).toBe(6000);
    next.providers[0].windows[0].id = "claude-weekly-scoped-unknown";
    expect(measured(next).windows[0].tokensPerPercent).toBeNull();
  });

  it("supports credit allowances without mutating the upstream windows", () => {
    const credits = { title: "月間", used: 10, limit: 100, balance: 90 };
    const value = snapshot(10, NOW, { id: "commandcode", windows: [], credits });
    measured(value); record(NOW + 1000, "a", "commandcode");
    const result = measured(snapshot(12, NOW + 2000, { id: "commandcode", windows: [], credits: { ...credits, used: 12 } }));
    expect(result.windows.find((w) => w.id === "credits")?.tokensPerPercent).toBe(500);
    expect(value.providers[0].windows).toEqual([]);
  });

  it("gracefully returns the original usage when storage is unavailable", () => {
    writeFileSync(join(dir, "codexbar-token-usage.sqlite"), "blocked");
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(dir, "codexbar-token-usage.sqlite", "invalid"));
    const value = snapshot();
    expect(attachTokenUsage(value)).toBe(value);
  });
});
