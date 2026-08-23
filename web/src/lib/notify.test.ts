// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { decideNotification, notificationText } from "./notify";

const base = {
  prevAttention: false,
  attention: false,
  prevWorking: false,
  working: false,
  documentHidden: true,
  permission: "granted" as NotificationPermission,
};

describe("decideNotification", () => {
  it("returns null without granted permission", () => {
    expect(
      decideNotification({ ...base, permission: "default", attention: true }),
    ).toBeNull();
  });

  it("returns null when the tab is focused", () => {
    expect(
      decideNotification({ ...base, documentHidden: false, attention: true }),
    ).toBeNull();
  });

  it("notifies attention on rising edge", () => {
    expect(decideNotification({ ...base, attention: true })).toBe("attention");
  });

  it("does not re-notify attention when already pending", () => {
    expect(
      decideNotification({ ...base, prevAttention: true, attention: true }),
    ).toBeNull();
  });

  it("notifies done when work finishes with nothing pending", () => {
    expect(
      decideNotification({ ...base, prevWorking: true, working: false }),
    ).toBe("done");
  });

  it("prefers attention over done on the same tick", () => {
    expect(
      decideNotification({
        ...base,
        prevWorking: true,
        working: false,
        attention: true,
      }),
    ).toBe("attention");
  });

  it("does not fire done while still working", () => {
    expect(
      decideNotification({ ...base, prevWorking: true, working: true }),
    ).toBeNull();
  });
});

describe("notificationText", () => {
  it("labels attention and done", () => {
    expect(notificationText("attention", "T").title).toContain("承認");
    expect(notificationText("done", "T").title).toContain("完了");
  });

  it("falls back to a default name", () => {
    expect(notificationText("done", "").body).toBe("LeafCode タスク");
  });
});
