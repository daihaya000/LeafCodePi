// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  decideNotification,
  isRoutineRunHandledInline,
  MAX_ROUTINE_ERROR_CHARS,
  notificationText,
  routineRunNotificationText,
} from "./notify";

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

describe("routineRunNotificationText", () => {
  const base = {
    botName: "リサーチャー",
    routineName: "朝の確認",
    preview: null,
    error: null,
    autoDisabled: false,
  };

  it("labels a finished run with the Bot name, routine name and preview", () => {
    expect(
      routineRunNotificationText({ ...base, ok: true, preview: "今日の予定は3件です" }),
    ).toEqual({
      title: "ルーティン完了",
      body: "リサーチャー・朝の確認\n今日の予定は3件です",
    });
  });

  it("omits the preview when the reply is empty", () => {
    expect(routineRunNotificationText({ ...base, ok: true }).body).toBe(
      "リサーチャー・朝の確認",
    );
  });

  it("shows the failure reason and the auto-disable notice", () => {
    const text = routineRunNotificationText({
      ...base,
      ok: false,
      error: "プロバイダが応答しません",
      autoDisabled: true,
    });
    expect(text.title).toBe("ルーティン失敗（自動無効化）");
    expect(text.body).toContain("プロバイダが応答しません");
  });

  it("falls back to placeholders when names are missing", () => {
    expect(routineRunNotificationText({ botName: "", routineName: "", ok: true }).body).toBe(
      "Bot・ルーティン",
    );
  });

  it("clips a long failure reason to the notification length", () => {
    const long = "あ".repeat(MAX_ROUTINE_ERROR_CHARS + 50);
    expect(routineRunNotificationText({ ...base, ok: false, error: long }).body).toBe(
      `リサーチャー・朝の確認\n${"あ".repeat(MAX_ROUTINE_ERROR_CHARS - 1)}…`,
    );
  });
});

describe("isRoutineRunHandledInline", () => {
  it("treats the open Bot tab as handled and everything else as global", () => {
    expect(isRoutineRunHandledInline("/bots/bot-1", "bot-1")).toBe(true);
    expect(isRoutineRunHandledInline("/bots/bot-2", "bot-1")).toBe(false);
    expect(isRoutineRunHandledInline("/task/abc", "bot-1")).toBe(false);
    expect(isRoutineRunHandledInline(null, "bot-1")).toBe(false);
    expect(isRoutineRunHandledInline("/bots/", "")).toBe(false);
  });
});
