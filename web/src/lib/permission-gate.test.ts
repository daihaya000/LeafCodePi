import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  parsePermissionMode,
  PERMISSION_OPTIONS,
} from "./permission-gate";

describe("permission mode setting", () => {
  it("defaults to allow when nothing is stored", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("allow");
    expect(parsePermissionMode(null)).toBe("allow");
    expect(parsePermissionMode(undefined)).toBe("allow");
  });

  it("returns every stored mode offered in Settings", () => {
    for (const { value } of PERMISSION_OPTIONS) {
      expect(isPermissionMode(value)).toBe(true);
      expect(parsePermissionMode(value)).toBe(value);
    }
  });

  it("falls back to allow for invalid or corrupted values", () => {
    for (const raw of ["turbo", "{}", "", "ALLOW", 1]) {
      expect(isPermissionMode(raw)).toBe(false);
      expect(parsePermissionMode(raw)).toBe("allow");
    }
  });
});
