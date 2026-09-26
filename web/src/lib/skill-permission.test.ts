import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_PERMISSION,
  isSkillPermission,
  parseSkillPermission,
} from "./skill-permission";

describe("skill permission setting", () => {
  it("defaults to allow", () => {
    expect(DEFAULT_SKILL_PERMISSION).toBe("allow");
    expect(parseSkillPermission(null)).toBe("allow");
  });

  it("returns a stored choice and rejects other values", () => {
    expect(parseSkillPermission("deny")).toBe("deny");
    expect(parseSkillPermission("allow")).toBe("allow");
    expect(isSkillPermission("ask")).toBe(false);
    expect(parseSkillPermission("ask")).toBe("allow");
  });
});
