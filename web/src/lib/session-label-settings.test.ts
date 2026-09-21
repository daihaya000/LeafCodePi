import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_LABELS,
  MAX_SESSION_LABEL_HINT_CHARS,
  MAX_SESSION_LABELS,
  normalizeSessionLabels,
  parseSessionLabels,
  resolveSessionLabels,
} from "./session-label-settings";

const valid = { id: "debug", name: "デバッグ", hint: "不具合の調査", color: "red" };

describe("parseSessionLabels", () => {
  it("accepts a valid array", () => {
    expect(parseSessionLabels(JSON.stringify([valid]))).toEqual([valid]);
  });

  it("accepts an empty array as 'labelling disabled'", () => {
    expect(parseSessionLabels("[]")).toEqual([]);
  });

  it("rejects malformed JSON, bad colors, empty names, and oversized fields", () => {
    expect(parseSessionLabels("{")).toBeNull();
    expect(parseSessionLabels(JSON.stringify([{ ...valid, color: "gray" }]))).toBeNull();
    expect(parseSessionLabels(JSON.stringify([{ ...valid, name: "  " }]))).toBeNull();
    expect(
      parseSessionLabels(JSON.stringify([{ ...valid, hint: "あ".repeat(MAX_SESSION_LABEL_HINT_CHARS + 1) }])),
    ).toBeNull();
  });

  it("rejects more than the maximum number of labels", () => {
    const many = Array.from({ length: MAX_SESSION_LABELS + 1 }, (_, i) => ({
      ...valid,
      id: `id-${i}`,
      name: `名前${i}`,
    }));
    expect(parseSessionLabels(JSON.stringify(many))).toBeNull();
  });
});

describe("normalizeSessionLabels", () => {
  it("drops invalid entries and duplicate ids or names", () => {
    expect(
      normalizeSessionLabels([
        valid,
        { ...valid, hint: "重複id" },
        { ...valid, id: "other" },
        "nope",
      ]),
    ).toEqual([valid]);
  });
});

describe("resolveSessionLabels", () => {
  it("uses the defaults only when never configured", () => {
    expect(resolveSessionLabels(null)).toEqual([...DEFAULT_SESSION_LABELS]);
    expect(resolveSessionLabels("")).toEqual([...DEFAULT_SESSION_LABELS]);
    expect(resolveSessionLabels("[]")).toEqual([]);
    expect(resolveSessionLabels(JSON.stringify([valid]))).toEqual([valid]);
  });
});
