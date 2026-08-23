// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSkillPermission,
  SKILL_PERMISSION_EVENT,
  SKILL_PERMISSION_STORAGE_KEY,
  writeSkillPermission,
} from "./skill-permission";

describe("skill permission", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to allow", () => {
    expect(readSkillPermission()).toBe("allow");
  });

  it("persists the choice and notifies listeners", () => {
    const listener = vi.fn();
    window.addEventListener(SKILL_PERMISSION_EVENT, listener);

    writeSkillPermission("deny");

    expect(localStorage.getItem(SKILL_PERMISSION_STORAGE_KEY)).toBe("deny");
    expect(readSkillPermission()).toBe("deny");
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toBe("deny");

    window.removeEventListener(SKILL_PERMISSION_EVENT, listener);
  });
});
