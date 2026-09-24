import { describe, expect, it } from "vitest";
import { parseAutoArchiveDays } from "./auto-archive-settings";

describe("parseAutoArchiveDays", () => {
  it("defaults to 14 days without overriding saved options", () => {
    expect(parseAutoArchiveDays(null)).toBe(14);
    expect(parseAutoArchiveDays("30")).toBe(30);
    expect(parseAutoArchiveDays("off")).toBeNull();
  });
});
