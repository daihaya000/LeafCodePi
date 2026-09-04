import { describe, expect, it } from "vitest";
import { buildEntry, buildSnapshotFile, toOpencodeProviderId } from "./export";
import { tryGetMonthlyUsd } from "./plan-pricing";
import type { UsageSnapshot } from "./types";
import { representativePercent } from "./utils";

function snap(partial: Partial<UsageSnapshot> & Pick<UsageSnapshot, "windows">): UsageSnapshot {
  return {
    providerId: "anthropic",
    providerName: "Claude",
    plan: null,
    accountEmail: null,
    creditsBalance: null,
    creditsLabel: null,
    creditsEnabled: false,
    creditsTitle: null,
    creditsUsed: null,
    creditsLimit: null,
    sourceLabel: null,
    updatedAt: new Date("2026-08-21T00:00:00Z"),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
    ...partial,
  };
}

describe("toOpencodeProviderId", () => {
  it("maps known providers", () => {
    expect(toOpencodeProviderId("openai-codex")).toBe("openai");
    expect(toOpencodeProviderId("anthropic")).toBe("anthropic");
    expect(toOpencodeProviderId("cursor")).toBe("cursor-acp");
    expect(toOpencodeProviderId("openrouter")).toBe("openrouter");
    expect(toOpencodeProviderId("mystery")).toBeNull();
  });
});

describe("tryGetMonthlyUsd", () => {
  it("resolves longer plan keys first", () => {
    expect(tryGetMonthlyUsd("anthropic", "Max 20x")).toBe(200);
    expect(tryGetMonthlyUsd("anthropic", "Max")).toBe(100);
    expect(tryGetMonthlyUsd("cursor", "Pro+")).toBe(60);
    expect(tryGetMonthlyUsd("cursor", "Pro")).toBe(20);
    expect(tryGetMonthlyUsd("openai-codex", "Free")).toBeNull();
  });
});

describe("buildEntry", () => {
  it("uses max counting window for usedPercent and ignores breakdown-only peaks", () => {
    const entry = buildEntry(
      "cursor",
      snap({
        providerId: "cursor",
        providerName: "Cursor",
        plan: "Pro",
        windows: [
          {
            id: "cursor-plan",
            title: "プラン",
            usedPercent: 40,
            resetsAt: new Date("2026-09-01T00:00:00Z"),
            windowDurationMs: null,
            countsTowardLimit: true,
          },
          {
            id: "cursor-auto",
            title: "Auto",
            usedPercent: 100,
            resetsAt: null,
            windowDurationMs: null,
            countsTowardLimit: false,
          },
        ],
      }),
      null,
    );
    expect(entry).toMatchObject({
      codexBarProviderId: "cursor",
      opencodeProviderId: "cursor-acp",
      plan: "Pro",
      planMonthlyUsd: 20,
      usedPercent: 40,
      limited: false,
      maxed: false,
    });
    expect(entry!.windows).toHaveLength(2);
  });

  it("sets limited/maxed thresholds and plan monthly total", () => {
    const entry = buildEntry(
      "anthropic",
      snap({
        plan: "Pro",
        windows: [
          {
            id: "claude-5h",
            title: "5時間",
            usedPercent: 95,
            resetsAt: null,
            windowDurationMs: 300 * 60_000,
            countsTowardLimit: true,
          },
        ],
      }),
      null,
    );
    expect(entry!.limited).toBe(true);
    expect(entry!.maxed).toBe(false);
    expect(entry!.planMonthlyUsd).toBe(20);

    const maxed = buildEntry(
      "anthropic",
      snap({
        windows: [
          {
            id: "w",
            title: "週間",
            usedPercent: 99.6,
            resetsAt: null,
            windowDurationMs: null,
            countsTowardLimit: true,
          },
        ],
      }),
      null,
    );
    expect(maxed!.maxed).toBe(true);
  });

  it("keeps error null when last-good windows exist", () => {
    const entry = buildEntry(
      "openai-codex",
      snap({
        providerId: "openai-codex",
        windows: [
          {
            id: "codex-primary",
            title: "5時間",
            usedPercent: 10,
            resetsAt: null,
            windowDurationMs: null,
            countsTowardLimit: true,
          },
        ],
      }),
      "stale refresh failed",
    );
    expect(entry!.error).toBeNull();
    expect(entry!.usedPercent).toBe(10);
  });

  it("surfaces error when snapshot is empty", () => {
    const entry = buildEntry("openai-codex", null, "トークン切れ");
    expect(entry!.error).toBe("トークン切れ");
    expect(entry!.usedPercent).toBeNull();
  });

  it("includes credits fill in representative percent", () => {
    const s = snap({
      windows: [
        {
          id: "w",
          title: "5時間",
          usedPercent: 20,
          resetsAt: null,
          windowDurationMs: null,
          countsTowardLimit: true,
        },
      ],
      creditsEnabled: true,
      creditsUsed: 90,
      creditsLimit: 100,
    });
    expect(representativePercent(s)).toBe(90);
    const entry = buildEntry("anthropic", s, null);
    expect(entry!.usedPercent).toBe(90);
    expect(entry!.credits).toMatchObject({ used: 90, limit: 100 });
  });
});

describe("buildSnapshotFile", () => {
  it("sums planMonthlyUsd", () => {
    const a = buildEntry(
      "cursor",
      snap({
        providerId: "cursor",
        plan: "Pro",
        windows: [
          {
            id: "p",
            title: "プラン",
            usedPercent: 1,
            resetsAt: null,
            windowDurationMs: null,
            countsTowardLimit: true,
          },
        ],
      }),
      null,
    )!;
    const b = buildEntry(
      "anthropic",
      snap({
        plan: "Team",
        windows: [
          {
            id: "w",
            title: "週間",
            usedPercent: 1,
            resetsAt: null,
            windowDurationMs: null,
            countsTowardLimit: true,
          },
        ],
      }),
      null,
    )!;
    const file = buildSnapshotFile([a, b]);
    expect(file.schema).toBe("codexbar.usage-snapshot/v1");
    expect(file.subscriptionTotalMonthlyUsd).toBe(45);
    expect(file.providers).toHaveLength(2);
  });
});

describe("buildEntry reset credits", () => {
  it("forwards rateLimitResetCreditsAvailable", () => {
    const entry = buildEntry(
      "openai-codex",
      snap({
        providerId: "openai-codex",
        providerName: "Codex",
        windows: [
          {
            id: "codex-primary",
            title: "5時間",
            usedPercent: 40,
            resetsAt: null,
            windowDurationMs: null,
            countsTowardLimit: true,
          },
        ],
        rateLimitResetCreditsAvailable: 3,
      }),
      null,
    );
    expect(entry?.resetCreditsAvailable).toBe(3);
  });
});
