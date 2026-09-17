import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPiAuthPath } from "@/lib/codexbar/pi-auth";
import {
  estimatedTypesafeUsd,
  readTypesafeUsageTotals,
  recordTypesafeUsage,
  resolveTypesafeApiKey,
  typesafeProvider,
} from "./typesafe";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.LEAFCODE_PI_DATA_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-typesafe-usage-"));
  dirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  return dir;
}

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-typesafe-agent-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

describe("typesafe usage totals", () => {
  it("starts empty and accumulates across calls", () => {
    tempDataDir();
    expect(readTypesafeUsageTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      updatedAt: null,
    });

    recordTypesafeUsage({ input_tokens: 100, output_tokens: 20 });
    recordTypesafeUsage({ input_tokens: 50, output_tokens: 5 });

    const totals = readTypesafeUsageTotals();
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(25);
    expect(totals.calls).toBe(2);
    expect(totals.updatedAt).not.toBeNull();
  });

  it("estimates USD from the published $42/Btok input price (output free)", () => {
    expect(estimatedTypesafeUsd({ inputTokens: 1_000_000_000, outputTokens: 0, calls: 1, updatedAt: null })).toBe(42);
    expect(estimatedTypesafeUsd({ inputTokens: 0, outputTokens: 999, calls: 1, updatedAt: null })).toBe(0);
  });

  it("never throws when the counter file is corrupt", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "typesafe-usage.json"), "{not json", "utf8");
    expect(readTypesafeUsageTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      updatedAt: null,
    });
    expect(() => recordTypesafeUsage({ input_tokens: 1 })).not.toThrow();
  });
});

describe("resolveTypesafeApiKey / typesafeProvider", () => {
  it("is unconfigured without a stored api_key entry", () => {
    tempAgentDir();
    expect(resolveTypesafeApiKey()).toBeNull();
    expect(typesafeProvider.isConfigured()).toBe(false);
  });

  it("is configured once auth.json has a typesafe api_key entry", () => {
    tempAgentDir();
    writeFileSync(
      defaultPiAuthPath(),
      JSON.stringify({ typesafe: { type: "api_key", key: "sk-test" } }),
      "utf8",
    );
    expect(resolveTypesafeApiKey()).toBe("sk-test");
    expect(typesafeProvider.isConfigured()).toBe(true);
  });

  it("fetch() reports a display-only estimated-usage snapshot, not a real balance", async () => {
    tempDataDir();
    recordTypesafeUsage({ input_tokens: 1_000_000_000, output_tokens: 1 });

    const snapshot = await typesafeProvider.fetch();
    expect(snapshot.providerId).toBe("typesafe");
    expect(snapshot.creditsEnabled).toBe(true);
    expect(snapshot.creditsUsed).toBe(42);
    expect(snapshot.creditsLimit).toBeNull();
    expect(snapshot.creditsBalance).toBeNull();
    expect(snapshot.usageDisplayOnly).toBe(true);
    expect(snapshot.windows).toEqual([]);
  });
});
