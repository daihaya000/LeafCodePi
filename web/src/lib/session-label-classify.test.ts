import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evaluateTypeSafe: vi.fn() }));
vi.mock("@/lib/pi/typesafe-system-one", () => ({
  evaluateTypeSafe: mocks.evaluateTypeSafe,
}));

import { classifySessionLabelWithJev, matchSessionLabelByRule } from "./auto-jev";
import { DEFAULT_SESSION_LABELS, type SessionLabel } from "./session-label-settings";

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

  it("falls back on low confidence or unknown names, and accepts one label", async () => {
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

    mocks.evaluateTypeSafe.mockResolvedValue({
      answers: { label: { choice: "デバッグ", confidence: 0.9 } },
    });
    await expect(
      classifySessionLabelWithJev({ prompt: "エラー", labels: labels.slice(0, 1) }),
    ).resolves.toBe("debug");
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

  it("returns undefined with no overlap or empty input", () => {
    expect(matchSessionLabelByRule("hello", labels)).toBeUndefined();
    expect(matchSessionLabelByRule("", labels)).toBeUndefined();
  });

  it("breaks a tie with the label listed first", () => {
    const tied: SessionLabel[] = [
      { id: "a", name: "AA", hint: "修正", color: "red" },
      { id: "b", name: "BB", hint: "リファクタ", color: "blue" },
    ];
    expect(matchSessionLabelByRule("修正 リファクタ", tied)).toBe("a");
    expect(matchSessionLabelByRule("修正 リファクタ", [...tied].reverse())).toBe("b");
  });

  it("labels the everyday requests that used to tie between debug and code", () => {
    // どれも「不具合/エラー」(debug) と「修正」(code) が1語ずつ一致し、以前はラベル無しになっていた。
    for (const prompt of [
      "スマホでのスクロール操作が安定しない不具合を修正",
      "ツール周りの不具合をすべて修正",
      "invalid files のエラーで続行できない問題修正",
    ]) {
      expect(matchSessionLabelByRule(prompt, DEFAULT_SESSION_LABELS)).toBe("debug");
    }
  });
});
