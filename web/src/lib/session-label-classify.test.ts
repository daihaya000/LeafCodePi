import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evaluateTypeSafe: vi.fn() }));
vi.mock("@/lib/pi/typesafe-system-one", () => ({
  evaluateTypeSafe: mocks.evaluateTypeSafe,
}));

import { classifySessionLabelWithJev, matchSessionLabelByRule } from "./auto-jev";
import type { SessionLabel } from "./session-label-settings";

const originalRouting = process.env.TYPESAFE_AUTO_ROUTING;

const labels: SessionLabel[] = [
  { id: "debug", name: "デバッグ", hint: "不具合・エラーの調査や修正", color: "red" },
  { id: "code", name: "コード", hint: "実装・リファクタ", color: "blue" },
];

afterEach(() => {
  mocks.evaluateTypeSafe.mockReset();
  if (originalRouting === undefined) delete process.env.TYPESAFE_AUTO_ROUTING;
  else process.env.TYPESAFE_AUTO_ROUTING = originalRouting;
});

describe("classifySessionLabelWithJev", () => {
  it("maps the chosen label name back to its id", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { label: { choice: "デバッグ", confidence: 0.8 } },
    });

    await expect(
      classifySessionLabelWithJev({ prompt: "エラーを直して", labels }),
    ).resolves.toBe("debug");
  });

  it("falls back on low confidence, unknown names, or too few labels", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { label: { choice: "デバッグ", confidence: 0.3 } },
    });
    await expect(
      classifySessionLabelWithJev({ prompt: "エラー", labels }),
    ).resolves.toBeUndefined();

    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { label: { choice: "未知", confidence: 0.9 } },
    });
    await expect(
      classifySessionLabelWithJev({ prompt: "エラー", labels }),
    ).resolves.toBeUndefined();

    mocks.evaluateTypeSafe.mockClear();
    await expect(
      classifySessionLabelWithJev({ prompt: "エラー", labels: labels.slice(0, 1) }),
    ).resolves.toBeUndefined();
    expect(mocks.evaluateTypeSafe).not.toHaveBeenCalled();
  });

  it("returns undefined when Jev is unavailable", async () => {
    process.env.TYPESAFE_AUTO_ROUTING = "1";
    mocks.evaluateTypeSafe.mockRejectedValue(new Error("offline"));

    await expect(
      classifySessionLabelWithJev({ prompt: "エラー", labels }),
    ).resolves.toBeUndefined();
  });
});

describe("matchSessionLabelByRule", () => {
  it("picks the label whose own words appear in the prompt", () => {
    expect(matchSessionLabelByRule("リファクタしたい", labels)).toBe("code");
  });

  it("returns undefined with no overlap, empty input, or a tie", () => {
    expect(matchSessionLabelByRule("hello", labels)).toBeUndefined();
    expect(matchSessionLabelByRule("", labels)).toBeUndefined();
    expect(
      matchSessionLabelByRule("修正 リファクタ", [
        { id: "a", name: "AA", hint: "修正", color: "red" },
        { id: "b", name: "BB", hint: "リファクタ", color: "blue" },
      ]),
    ).toBeUndefined();
  });
});
