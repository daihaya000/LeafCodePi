import { describe, expect, it } from "vitest";
import { normalizeMachineName } from "./machine-name";

describe("normalizeMachineName", () => {
  it("uses a lowercase machine label without any domain suffix", () => {
    expect(normalizeMachineName("X870")).toBe("x870");
    expect(normalizeMachineName("X870.example.local")).toBe("x870");
  });

  it("normalizes unsafe characters and bounds the result", () => {
    expect(normalizeMachineName("Work Station")).toBe("work-station");
    expect(normalizeMachineName(" ")).toBe("unknown");
    expect(normalizeMachineName(`a${"b".repeat(80)}`)).toHaveLength(63);
  });
});
