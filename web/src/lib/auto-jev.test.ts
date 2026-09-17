import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evaluateTypeSafe: vi.fn() }));
vi.mock("@/lib/pi/typesafe-system-one", () => ({
  evaluateTypeSafe: mocks.evaluateTypeSafe,
}));

import { classifyAutoTierWithJev, selectAutoAgentWithJev } from "./auto-jev";

const originalRouting = process.env.TYPESAFE_AUTO_ROUTING;

afterEach(() => {
  mocks.evaluateTypeSafe.mockReset();
  if (originalRouting === undefined) delete process.env.TYPESAFE_AUTO_ROUTING;
  else process.env.TYPESAFE_AUTO_ROUTING = originalRouting;
});

describe("Auto Jev routing", () => {
  it("uses Jev's valid high-confidence tier", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { tier: { choice: "heavy", confidence: 0.82 } },
    });

    await expect(
      classifyAutoTierWithJev({
        prompt: "全体をリファクタして",
        hasImages: false,
        attachmentCount: 0,
        historyMessageCount: 0,
        recentFailure: false,
      }),
    ).resolves.toBe("heavy");
  });

  it("falls back when tier confidence is low or missing", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { tier: { choice: "heavy", confidence: 0.59 } },
    });
    await expect(
      classifyAutoTierWithJev({
        prompt: "全体をリファクタして",
        hasImages: false,
        attachmentCount: 0,
        historyMessageCount: 0,
        recentFailure: false,
      }),
    ).resolves.toBeUndefined();

    mocks.evaluateTypeSafe.mockResolvedValue({ answers: { tier: { choice: "heavy" } } });
    await expect(
      classifyAutoTierWithJev({
        prompt: "全体をリファクタして",
        hasImages: false,
        attachmentCount: 0,
        historyMessageCount: 0,
        recentFailure: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when Jev is unavailable", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockRejectedValue(new Error("offline"));

    await expect(
      classifyAutoTierWithJev({
        prompt: "修正して",
        hasImages: false,
        attachmentCount: 0,
        historyMessageCount: 0,
        recentFailure: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts only a configured agent name", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { agent: { choice: "builder", confidence: 0.81 } },
    });
    const candidates = [
      { name: "builder", description: "implements", canModifyFiles: true },
      { name: "reviewer", description: "reviews", canModifyFiles: false },
    ];

    await expect(selectAutoAgentWithJev({ prompt: "実装して", candidates })).resolves.toBe("builder");
    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { agent: { choice: "unknown", confidence: 0.9 } },
    });
    await expect(selectAutoAgentWithJev({ prompt: "実装して", candidates })).resolves.toBeUndefined();

    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { agent: { choice: "builder", confidence: 0.59 } },
    });
    await expect(selectAutoAgentWithJev({ prompt: "実装して", candidates })).resolves.toBeUndefined();
  });
});
