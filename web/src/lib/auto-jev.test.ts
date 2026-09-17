import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evaluateTypeSafe: vi.fn() }));
vi.mock("@/lib/pi/typesafe-system-one", () => ({
  evaluateTypeSafe: mocks.evaluateTypeSafe,
}));

import {
  classifyAutoTierWithJev,
  selectAutoAgentWithJev,
  selectRelevantFilesWithJev,
  selectRelevantSkillsWithJev,
  selectRelevantToolsWithJev,
} from "./auto-jev";

const originalRouting = process.env.TYPESAFE_AUTO_ROUTING;

afterEach(() => {
  mocks.evaluateTypeSafe.mockReset();
  if (originalRouting === undefined) delete process.env.TYPESAFE_AUTO_ROUTING;
  else process.env.TYPESAFE_AUTO_ROUTING = originalRouting;
});

describe("Auto Jev routing", () => {
  it("uses Jev's valid tier", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockResolvedValue({ answers: { tier: { choice: "heavy" } } });

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

  it("selects only relevant skill, file, and already-matched tool candidates", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: {
        candidate_0: { noul: 0.9 },
        candidate_1: { noul: 0.1 },
      },
    });
    const candidates = [
      { name: "wanted", description: "relevant" },
      { name: "other", description: "not relevant" },
    ];

    await expect(selectRelevantSkillsWithJev({ prompt: "wanted", candidates })).resolves.toEqual(new Set(["wanted"]));
    await expect(selectRelevantFilesWithJev({ prompt: "wanted", candidates })).resolves.toEqual(new Set(["wanted"]));
    await expect(selectRelevantToolsWithJev({ prompt: "wanted", candidates })).resolves.toEqual(new Set(["wanted"]));

    mocks.evaluateTypeSafe.mockResolvedValue({ answers: { candidate_0: { noul: 0.1 } } });
    await expect(selectRelevantSkillsWithJev({ prompt: "none", candidates })).resolves.toBeUndefined();
  });

  it("accepts only a configured agent name", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockResolvedValue({ answers: { agent: { choice: "builder" } } });
    const candidates = [
      { name: "builder", description: "implements", canModifyFiles: true },
      { name: "reviewer", description: "reviews", canModifyFiles: false },
    ];

    await expect(selectAutoAgentWithJev({ prompt: "実装して", candidates })).resolves.toBe("builder");
    mocks.evaluateTypeSafe.mockResolvedValue({ answers: { agent: { choice: "unknown" } } });
    await expect(selectAutoAgentWithJev({ prompt: "実装して", candidates })).resolves.toBeUndefined();
  });
});
