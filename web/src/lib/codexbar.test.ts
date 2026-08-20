import { describe, expect, it } from "vitest";
import {
  clampPercent,
  emptyUsage,
  formatMonthlyTotal,
  formatMonthlyUsd,
  formatPlanBadge,
  formatResetsIn,
  hasLastGoodUsage,
  isStale,
  limitedCount,
  overallUsedPercent,
  parseCodexBarSnapshot,
  percentTone,
  providerIconSrc,
  providerIconSrcForOpencodeId,
  providerLabel,
  STALE_AFTER_MS,
  usageTone,
  worstProvider,
} from "./codexbar";

const SAMPLE = {
  schema: "codexbar.usage-snapshot/v1",
  generatedAt: "2026-07-17T03:34:32.55Z",
  providers: [
    {
      opencodeProviderId: "openai",
      codexBarProviderId: "codex",
      usedPercent: 1,
      limited: false,
      maxed: false,
      resetsAt: "2026-07-24T01:44:16Z",
      updatedAt: "2026-07-17T03:34:32Z",
    },
    {
      opencodeProviderId: "cursor",
      codexBarProviderId: "cursor",
      usedPercent: 100,
      limited: true,
      maxed: true,
      resetsAt: "2026-07-18T05:47:03Z",
      updatedAt: "2026-07-17T03:34:31Z",
    },
  ],
};

describe("parseCodexBarSnapshot", () => {
  it("parses a valid snapshot", () => {
    const u = parseCodexBarSnapshot(SAMPLE);
    expect(u.available).toBe(true);
    expect(u.schema).toBe("codexbar.usage-snapshot/v1");
    expect(u.providers).toHaveLength(2);
    expect(u.providers[0]).toMatchObject({
      id: "codex",
      opencodeId: "openai",
      usedPercent: 1,
      limited: false,
      maxed: false,
    });
    expect(u.providers[1]).toMatchObject({ id: "cursor", limited: true, maxed: true });
  });

  it("derives limited/maxed from usedPercent when flags absent", () => {
    const u = parseCodexBarSnapshot({
      providers: [{ codexBarProviderId: "claude", usedPercent: 95 }],
    });
    expect(u.providers[0].limited).toBe(true);
    expect(u.providers[0].maxed).toBe(false);
    const u2 = parseCodexBarSnapshot({
      providers: [{ codexBarProviderId: "claude", usedPercent: 99.9 }],
    });
    expect(u2.providers[0].maxed).toBe(true);
  });

  it("falls back to opencode id and 'unknown' for the provider id", () => {
    expect(parseCodexBarSnapshot({ providers: [{ opencodeProviderId: "foo" }] }).providers[0].id).toBe("foo");
    expect(parseCodexBarSnapshot({ providers: [{}] }).providers[0].id).toBe("unknown");
  });

  it("captures error and keeps usedPercent null", () => {
    const u = parseCodexBarSnapshot({
      providers: [{ codexBarProviderId: "ollama", error: "timeout" }],
    });
    expect(u.providers[0].error).toBe("timeout");
    expect(u.providers[0].usedPercent).toBeNull();
  });

  it("returns unavailable for non-objects and missing providers", () => {
    expect(parseCodexBarSnapshot(null).available).toBe(false);
    expect(parseCodexBarSnapshot("x").available).toBe(false);
    expect(parseCodexBarSnapshot({}).available).toBe(false);
    expect(parseCodexBarSnapshot({ providers: "nope" }).available).toBe(false);
  });

  it("parses the plan label and defaults to null", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        { codexBarProviderId: "claude", usedPercent: 10, plan: "Max" },
        { codexBarProviderId: "codex", usedPercent: 10 },
        { codexBarProviderId: "cursor", usedPercent: 10, plan: "" },
      ],
    });
    expect(u.providers[0].plan).toBe("Max");
    expect(u.providers[1].plan).toBeNull();
    expect(u.providers[2].plan).toBeNull();
  });

  it("parses planMonthlyUsd and subscriptionTotalMonthlyUsd", () => {
    const u = parseCodexBarSnapshot({
      subscriptionTotalMonthlyUsd: 100,
      providers: [
        { codexBarProviderId: "cursor", plan: "Pro", planMonthlyUsd: 20, usedPercent: 10 },
        { codexBarProviderId: "claude", plan: "Team", planMonthlyUsd: 25, usedPercent: 10 },
        { codexBarProviderId: "synthetic", plan: null, usedPercent: 0 },
      ],
    });
    expect(u.subscriptionTotalMonthlyUsd).toBe(100);
    expect(u.providers[0].planMonthlyUsd).toBe(20);
    expect(u.providers[2].planMonthlyUsd).toBeNull();
  });

  it("sums planMonthlyUsd when root total is absent", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        { codexBarProviderId: "cursor", planMonthlyUsd: 20 },
        { codexBarProviderId: "ollama", planMonthlyUsd: 20 },
      ],
    });
    expect(u.subscriptionTotalMonthlyUsd).toBe(40);
  });

  it("skips non-object provider entries", () => {
    const u = parseCodexBarSnapshot({ providers: [null, 3, { codexBarProviderId: "codex" }] });
    expect(u.providers).toHaveLength(1);
    expect(u.providers[0].id).toBe("codex");
  });
});

describe("parseCodexBarSnapshot windows", () => {
  it("parses per-window detail defensively", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        {
          codexBarProviderId: "claude",
          usedPercent: 23,
          windows: [
            { id: "claude-5h", title: "5時間", usedPercent: 0, windowMinutes: 300 },
            {
              id: "claude-weekly",
              title: "週間",
              usedPercent: 13,
              resetsAt: "2026-07-20T05:00:00Z",
              windowMinutes: 10080,
            },
            null,
            "junk",
          ],
        },
      ],
    });
    expect(u.providers[0].windows).toHaveLength(2);
    expect(u.providers[0].windows[0]).toEqual({
      id: "claude-5h",
      title: "5時間",
      usedPercent: 0,
      resetsAt: null,
      windowMinutes: 300,
    });
    expect(u.providers[0].windows[1].usedPercent).toBe(13);
  });

  it("defaults windows to [] when absent or not an array", () => {
    expect(parseCodexBarSnapshot({ providers: [{ codexBarProviderId: "codex" }] }).providers[0].windows).toEqual([]);
    expect(
      parseCodexBarSnapshot({ providers: [{ codexBarProviderId: "codex", windows: "no" }] }).providers[0].windows,
    ).toEqual([]);
  });
});

describe("parseCodexBarSnapshot credits", () => {
  it("parses complete credit information", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        {
          codexBarProviderId: "claude",
          usedPercent: 10,
          credits: {
            title: "利用クレジット",
            used: 12.5,
            limit: 300,
            balance: 287.5,
          },
        },
      ],
    });

    expect(u.providers[0].credits).toEqual({
      title: "利用クレジット",
      used: 12.5,
      limit: 300,
      balance: 287.5,
    });
  });

  it("normalizes missing and invalid credit fields independently", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        { codexBarProviderId: "a", credits: { used: 4, limit: Number.NaN } },
        { codexBarProviderId: "b", credits: { title: "", balance: Infinity } },
        { codexBarProviderId: "c", credits: "invalid" },
        { codexBarProviderId: "d", credits: [] },
        { codexBarProviderId: "e" },
      ],
    });

    expect(u.providers[0].credits).toEqual({
      title: null,
      used: 4,
      limit: null,
      balance: null,
    });
    expect(u.providers[1].credits).toEqual({
      title: null,
      used: null,
      limit: null,
      balance: null,
    });
    expect(u.providers.slice(2).map((provider) => provider.credits)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("includes credit consumption in rate-limit aggregates", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        {
          codexBarProviderId: "claude",
          usedPercent: 20,
          credits: { used: 300, limit: 300, balance: 0 },
        },
      ],
    });

    expect(overallUsedPercent(u)).toBe(100);
    expect(limitedCount(u)).toBe(1);
    expect(u.providers[0]).toMatchObject({ usedPercent: 100, limited: true, maxed: true });
  });

  it("uses a credit-only provider in the overall percentage", () => {
    const u = parseCodexBarSnapshot({
      providers: [{ codexBarProviderId: "commandcode", credits: { used: 0, limit: 10 } }],
    });
    expect(overallUsedPercent(u)).toBe(0);
  });

  it("excludes an unbounded OpenRouter key from the overall percentage", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        { codexBarProviderId: "codex", usedPercent: 50 },
        {
          codexBarProviderId: "openrouter",
          usedPercent: 0,
          credits: { title: "利用額", used: 4.26, limit: null, balance: null },
        },
      ],
    });

    expect(u.providers[1].usedPercent).toBeNull();
    expect(overallUsedPercent(u)).toBe(50);
  });
});

describe("percentTone", () => {
  it("maps thresholds and null", () => {
    expect(percentTone(null)).toBe("ok");
    expect(percentTone(10)).toBe("ok");
    expect(percentTone(80)).toBe("warn");
    expect(percentTone(95)).toBe("danger");
    expect(percentTone(100)).toBe("danger");
  });
});

describe("overallUsedPercent", () => {
  it("averages provider usedPercent and ignores nulls", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        { codexBarProviderId: "a", usedPercent: 10 },
        { codexBarProviderId: "b", usedPercent: 50 },
        { codexBarProviderId: "c", error: "x" },
      ],
    });
    expect(overallUsedPercent(u)).toBe(30); // (10+50)/2
    expect(overallUsedPercent(emptyUsage("x"))).toBeNull();
  });

  it("excludes error-only providers that export placeholder usedPercent:0", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        { codexBarProviderId: "a", usedPercent: 50 },
        {
          codexBarProviderId: "synthetic",
          usedPercent: 0,
          error: "API キーが未設定です",
          windows: [],
        },
      ],
    });
    expect(overallUsedPercent(u)).toBe(50);
  });
});

describe("hasLastGoodUsage", () => {
  it("rejects placeholder usedPercent:0 when error is set and windows/credits are empty", () => {
    // Live CodexBar export for synthetic with missing API key.
    expect(
      hasLastGoodUsage({
        usedPercent: 0,
        error: "API キーが未設定です",
        windows: [],
        credits: null,
      }),
    ).toBe(false);
    expect(
      hasLastGoodUsage({
        usedPercent: null,
        error: "API キーが未設定です",
        windows: [],
        credits: null,
      }),
    ).toBe(false);
  });

  it("keeps real last-good usage even when a refresh error is present", () => {
    expect(
      hasLastGoodUsage({
        usedPercent: 74,
        error: "stale refresh failed",
        windows: [{ id: "m", title: "月間", usedPercent: 74, resetsAt: null, windowMinutes: null }],
        credits: null,
      }),
    ).toBe(true);
    expect(
      hasLastGoodUsage({
        usedPercent: 0,
        error: null,
        windows: [],
        credits: null,
      }),
    ).toBe(true);
  });
});

describe("limitedCount", () => {
  it("counts limited or maxed providers", () => {
    const u = parseCodexBarSnapshot({
      providers: [
        { codexBarProviderId: "a", usedPercent: 10 },
        { codexBarProviderId: "b", usedPercent: 95 },
        { codexBarProviderId: "c", usedPercent: 100 },
      ],
    });
    expect(limitedCount(u)).toBe(2);
  });
});

describe("emptyUsage", () => {
  it("carries the reason and is unavailable", () => {
    const u = emptyUsage("nope");
    expect(u).toMatchObject({ available: false, reason: "nope", providers: [] });
  });
});

describe("providerLabel", () => {
  it("maps known ids and title-cases unknown ones", () => {
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerLabel("opencode-go")).toBe("OpenCode");
    expect(providerLabel("synthetic")).toBe("Synthetic");
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("mystery")).toBe("Mystery");
    expect(providerLabel("")).toBe("Unknown");
  });

  it("maps Qwen Cloud brand keys to the Qwen Cloud label", () => {
    expect(providerLabel("qwen-cloud")).toBe("Qwen Cloud");
    expect(providerLabel("qwen")).toBe("Qwen Cloud");
  });
});

describe("providerIconSrc", () => {
  it("maps known providers to bundled icons and null otherwise", () => {
    expect(providerIconSrc("codex")).toBe("/icons/codex.png");
    expect(providerIconSrc("commandcode")).toBe("/icons/commandcode.svg");
    expect(providerIconSrc("command-code")).toBe("/icons/commandcode.svg");
    expect(providerIconSrc("opencode-go")).toBe("/icons/opencode.png");
    expect(providerIconSrc("cursor")).toBe("/icons/cursor.png");
    expect(providerIconSrc("synthetic")).toBe("/icons/synthetic.png");
    expect(providerIconSrc("openrouter")).toBe("/icons/openrouter.svg");
    expect(providerIconSrc("mystery")).toBeNull();
    expect(providerIconSrc("")).toBeNull();
  });

  it("maps Qwen Cloud brand keys to the bundled qwen.png icon", () => {
    expect(providerIconSrc("qwen-cloud")).toBe("/icons/qwen.png");
    expect(providerIconSrc("qwen")).toBe("/icons/qwen.png");
  });

  it("maps LM Studio brand key to the bundled lmstudio.png icon", () => {
    expect(providerIconSrc("lmstudio")).toBe("/icons/lmstudio.png");
  });

  it("maps the llama-server brand key to the bundled llama.cpp icon", () => {
    expect(providerIconSrc("llama-server")).toBe("/icons/llama-server.png");
  });
});

describe("providerIconSrcForOpencodeId", () => {
  it("aliases OpenCode provider ids to bundled brand icons", () => {
    expect(providerIconSrcForOpencodeId("openai")).toBe("/icons/codex.png");
    expect(providerIconSrcForOpencodeId("anthropic")).toBe("/icons/claude.png");
    expect(providerIconSrcForOpencodeId("commandcode")).toBe("/icons/commandcode.svg");
    expect(providerIconSrcForOpencodeId("command-code")).toBe("/icons/commandcode.svg");
    expect(providerIconSrcForOpencodeId("cursor")).toBe("/icons/cursor.png");
    expect(providerIconSrcForOpencodeId("ollama")).toBe("/icons/ollama.png");
    expect(providerIconSrcForOpencodeId("ollama-cloud")).toBe("/icons/ollama.png");
    expect(providerIconSrcForOpencodeId("opencode-go")).toBe("/icons/opencode.png");
    expect(providerIconSrcForOpencodeId("synthetic")).toBe("/icons/synthetic.png");
    expect(providerIconSrcForOpencodeId("qwen-cloud")).toBe("/icons/qwen.png");
    expect(providerIconSrcForOpencodeId("qwen")).toBe("/icons/qwen.png");
    expect(providerIconSrcForOpencodeId("llama-server")).toBe("/icons/llama-server.png");
    expect(providerIconSrcForOpencodeId("mystery")).toBeNull();
    expect(providerIconSrcForOpencodeId("")).toBeNull();
  });
});

describe("formatPlanBadge", () => {
  it("appends monthly price when known", () => {
    expect(formatPlanBadge("Pro", 20)).toBe("Pro · $20");
    expect(formatPlanBadge("Team", 25)).toBe("Team · $25");
    expect(formatPlanBadge("Pro", null)).toBe("Pro");
    expect(formatPlanBadge(null, 20)).toBeNull();
    expect(formatMonthlyUsd(20)).toBe("$20");
    expect(formatMonthlyTotal(100)).toBe("$100/月");
  });
});

describe("usageTone", () => {
  it("prioritizes error only when no usage data, then maxed/limited, then thresholds", () => {
    expect(usageTone({ usedPercent: null, limited: false, maxed: false, error: "x", windows: [], credits: null })).toBe("danger");
    // CodexBar synthetic (API key missing): usedPercent 0 + error must still be danger.
    expect(
      usageTone({
        usedPercent: 0,
        limited: false,
        maxed: false,
        error: "API キーが未設定です",
        windows: [],
        credits: null,
      }),
    ).toBe("danger");
    expect(
      usageTone({
        usedPercent: 74,
        limited: false,
        maxed: false,
        error: "stale refresh failed",
        windows: [{ id: "m", title: "月間", usedPercent: 74, resetsAt: null, windowMinutes: null }],
        credits: null,
      }),
    ).toBe("ok");
    expect(usageTone({ usedPercent: 10, limited: true, maxed: false, error: null, windows: [], credits: null })).toBe("danger");
    expect(usageTone({ usedPercent: 80, limited: false, maxed: false, error: null, windows: [], credits: null })).toBe("warn");
    expect(usageTone({ usedPercent: 20, limited: false, maxed: false, error: null, windows: [], credits: null })).toBe("ok");
    expect(usageTone({ usedPercent: null, limited: false, maxed: false, error: null, windows: [], credits: null })).toBe("ok");
  });
});

describe("clampPercent", () => {
  it("clamps to 0..100 and handles null/NaN", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42)).toBe(42);
    expect(clampPercent(null)).toBe(0);
    expect(clampPercent(NaN)).toBe(0);
  });
});

describe("formatResetsIn", () => {
  const now = Date.parse("2026-07-17T00:00:00Z");
  it("formats minutes/hours/days and handles edges", () => {
    expect(formatResetsIn(null, now)).toBeNull();
    expect(formatResetsIn("not-a-date", now)).toBeNull();
    expect(formatResetsIn("2026-07-16T23:00:00Z", now)).toBe("まもなく");
    expect(formatResetsIn("2026-07-17T00:30:00Z", now)).toBe("30分後");
    expect(formatResetsIn("2026-07-17T05:00:00Z", now)).toBe("5時間後");
    expect(formatResetsIn("2026-07-19T00:00:00Z", now)).toBe("2日後");
    expect(formatResetsIn("2026-07-19T03:00:00Z", now)).toBe("2日3時間後");
  });
});

describe("isStale", () => {
  const now = Date.parse("2026-07-17T00:00:00Z");
  it("returns false for null/invalid timestamps", () => {
    expect(isStale(null, now)).toBe(false);
    expect(isStale("nope", now)).toBe(false);
  });
  it("flags snapshots older than the threshold", () => {
    expect(isStale("2026-07-16T23:58:00Z", now)).toBe(false); // 2m old
    expect(isStale("2026-07-16T23:40:00Z", now)).toBe(true); // 20m old
  });
  it("honors a custom threshold and uses the 15m default", () => {
    expect(STALE_AFTER_MS).toBe(15 * 60 * 1000);
    expect(isStale("2026-07-16T23:55:00Z", now, 60 * 1000)).toBe(true); // 5m > 1m
  });
});

describe("worstProvider", () => {
  it("returns the highest usage or the first errored provider", () => {
    const u = parseCodexBarSnapshot(SAMPLE);
    expect(worstProvider(u)?.id).toBe("cursor");
    expect(worstProvider(emptyUsage("x"))).toBeNull();
    const withErr = parseCodexBarSnapshot({
      providers: [{ codexBarProviderId: "a", usedPercent: 10 }, { codexBarProviderId: "b", error: "boom" }],
    });
    expect(worstProvider(withErr)?.id).toBe("b");
    const syntheticErr = parseCodexBarSnapshot({
      providers: [
        { codexBarProviderId: "a", usedPercent: 10 },
        {
          codexBarProviderId: "synthetic",
          usedPercent: 0,
          error: "API キーが未設定です",
        },
      ],
    });
    expect(worstProvider(syntheticErr)?.id).toBe("synthetic");
  });
});
