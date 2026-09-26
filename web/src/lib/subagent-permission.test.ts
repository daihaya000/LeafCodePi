import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_PERMISSION,
  isSubagentPermission,
  parseSubagentPermission,
} from "./subagent-permission";

describe("subagent permission setting", () => {
  it("defaults to deny", () => {
    expect(DEFAULT_SUBAGENT_PERMISSION).toBe("deny");
    expect(parseSubagentPermission(null)).toBe("deny");
  });

  it("returns a stored choice and fails closed for other values", () => {
    expect(parseSubagentPermission("allow")).toBe("allow");
    expect(parseSubagentPermission("deny")).toBe("deny");
    expect(isSubagentPermission("yes")).toBe(false);
    expect(parseSubagentPermission("yes")).toBe("deny");
  });
});
