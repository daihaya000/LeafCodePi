import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  __resetProviderRoutingQueueForTests,
  accountRoutingMode,
  chooseRoutingCandidate,
  providerRoutingPath,
  rankRoutingCandidates,
  readProviderRouting,
  setAccountRoutingMode,
  type RoutingUsage,
} from "./provider-routing";

function usage(
  usedPercent: number | null,
  options: Partial<Pick<RoutingUsage, "stale" | "maxed" | "resetsAt" | "error">> = {},
): RoutingUsage {
  return {
    usedPercent,
    maxed: options.maxed ?? false,
    stale: options.stale ?? false,
    resetsAt: options.resetsAt ?? null,
    error: options.error ?? null,
    windows: usedPercent === null ? [] : [{ id: "window", title: "window", usedPercent, resetsAt: null, windowMinutes: 300 }],
    credits: null,
  };
}

afterEach(() => {
  __resetProviderRoutingQueueForTests();
});

describe("provider routing settings", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults malformed or missing state to separate", () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-routing-"));
    dirs.push(dir);
    const path = providerRoutingPath(dir);
    assert.equal(accountRoutingMode("openai-codex", readProviderRouting(path)), "separate");
  });

  it("serializes updates without dropping the other provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-routing-"));
    dirs.push(dir);
    const path = providerRoutingPath(dir);
    await Promise.all([
      setAccountRoutingMode("openai-codex", "integrated", path),
      setAccountRoutingMode("anthropic", "integrated", path),
    ]);
    const state = readProviderRouting(path);
    assert.deepEqual(state.modes, { "openai-codex": "integrated", anthropic: "integrated" });
  });
});

describe("routing candidate ranking", () => {
  it("prefers the lower fresh usage", () => {
    const ranked = rankRoutingCandidates([
      { accountId: "high", accountIndex: 1, value: "high", usage: usage(80), workingTaskCount: 0 },
      { accountId: "low", accountIndex: 0, value: "low", usage: usage(20), workingTaskCount: 0 },
    ]);
    assert.deepEqual(ranked.map((candidate) => candidate.accountId), ["low", "high"]);
  });

  it("uses stale and unknown usage only after fresh usage", () => {
    const ranked = rankRoutingCandidates([
      { accountId: "unknown", accountIndex: 0, value: "unknown", usage: usage(null), workingTaskCount: 0 },
      { accountId: "stale", accountIndex: 1, value: "stale", usage: usage(1, { stale: true }), workingTaskCount: 0 },
      { accountId: "fresh", accountIndex: 2, value: "fresh", usage: usage(90), workingTaskCount: 0 },
    ]);
    assert.deepEqual(ranked.map((candidate) => candidate.accountId), ["fresh", "stale", "unknown"]);
  });

  it("returns the earliest reset when every fresh candidate is maxed", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const decision = chooseRoutingCandidate(
      [
        {
          accountId: "late",
          accountIndex: 0,
          value: "late",
          usage: usage(100, { maxed: true, resetsAt: "2026-01-02T00:00:00Z" }),
          workingTaskCount: 0,
        },
        {
          accountId: "early",
          accountIndex: 1,
          value: "early",
          usage: usage(100, { maxed: true, resetsAt: "2026-01-01T12:00:00Z" }),
          workingTaskCount: 0,
        },
      ],
      now,
    );
    assert.equal(decision.candidate, undefined);
    assert.equal(decision.allMaxed, true);
    assert.equal(decision.resetAt, "2026-01-01T12:00:00Z");
  });

  it("treats an expired maxed value as usable and breaks ties by load then account order", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    const decision = chooseRoutingCandidate(
      [
        {
          accountId: "busy",
          accountIndex: 0,
          value: "busy",
          usage: usage(99, { maxed: true, resetsAt: "2026-01-01T00:00:00Z" }),
          workingTaskCount: 2,
        },
        {
          accountId: "idle",
          accountIndex: 1,
          value: "idle",
          usage: usage(99, { maxed: true, resetsAt: "2026-01-01T00:00:00Z" }),
          workingTaskCount: 0,
        },
      ],
      now,
    );
    assert.equal(decision.candidate?.accountId, "idle");
  });
});
