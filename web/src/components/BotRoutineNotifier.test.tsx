// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  playSessionCompleteSound: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson, sendJson: vi.fn() }));
vi.mock("@/lib/session-complete-sound", () => ({
  playSessionCompleteSound: mocks.playSessionCompleteSound,
  playAttentionRequiredSound: vi.fn(),
}));

import { BotRoutineNotifier } from "./BotRoutineNotifier";
import { refreshBotSidebar } from "@/lib/bot-sidebar-store";

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static instances: { title: string; body?: string }[] = [];
  constructor(title: string, options?: NotificationOptions) {
    FakeNotification.instances.push({ title, body: options?.body });
  }
}

type StubSource = {
  listeners: Map<string, (event: MessageEvent) => void>;
  closed: boolean;
};

const sources: StubSource[] = [];

class TestSource {
  listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  constructor() {
    sources.push(this);
  }
  addEventListener(name: string, callback: (event: MessageEvent) => void) {
    this.listeners.set(name, callback);
  }
  removeEventListener(name: string) {
    this.listeners.delete(name);
  }
  close() {
    this.closed = true;
  }
}

const RUN = {
  botId: "bot-1",
  botName: "リサーチャー",
  routineId: "routine-1",
  routineName: "朝の確認",
  ok: true,
  at: "2026-09-19T00:00:00.000Z",
  preview: "今日の予定は3件です",
  error: null,
  failureCount: 0,
  autoDisabled: false,
};

function fireRoutine(run: Record<string, unknown>) {
  const source = sources[0];
  if (!source) throw new Error("Routine EventSource was not created");
  act(() => {
    source.listeners.get("routine")?.({ data: JSON.stringify(run) } as MessageEvent);
  });
}

beforeEach(() => {
  mocks.getJson.mockReset();
  mocks.playSessionCompleteSound.mockReset();
  FakeNotification.permission = "granted";
  FakeNotification.instances = [];
  sources.length = 0;
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("EventSource", TestSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "hidden");
  if (window.location.pathname !== "/") window.history.pushState({}, "", "/");
});

describe("BotRoutineNotifier", () => {
  it("rings the Bot sound and notifies a hidden tab when a routine finishes", async () => {
    mocks.getJson.mockResolvedValue({ bots: [{ id: "bot-1", notificationsEnabled: true }], rooms: [] });
    await refreshBotSidebar();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });

    render(<BotRoutineNotifier />);
    expect(sources).toHaveLength(1);
    fireRoutine(RUN);

    expect(mocks.playSessionCompleteSound).toHaveBeenCalledWith("bot");
    expect(FakeNotification.instances).toEqual([
      { title: "ルーティン完了", body: "リサーチャー・朝の確認\n今日の予定は3件です" },
    ]);
  });

  it("keeps ringing the sound but skips the notification on a visible tab", async () => {
    mocks.getJson.mockResolvedValue({ bots: [{ id: "bot-1", notificationsEnabled: true }], rooms: [] });
    await refreshBotSidebar();

    render(<BotRoutineNotifier />);
    fireRoutine({ ...RUN, ok: false, error: "プロバイダが応答しません" });

    expect(mocks.playSessionCompleteSound).toHaveBeenCalledWith("bot");
    expect(FakeNotification.instances).toEqual([]);
  });

  it("stays silent for a Bot whose notifications are turned off", async () => {
    mocks.getJson.mockResolvedValue({ bots: [{ id: "bot-1", notificationsEnabled: false }], rooms: [] });
    await refreshBotSidebar();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });

    render(<BotRoutineNotifier />);
    fireRoutine(RUN);

    expect(mocks.playSessionCompleteSound).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toEqual([]);
  });

  it("lets BotView handle a routine finished on the open Bot tab", async () => {
    mocks.getJson.mockResolvedValue({ bots: [{ id: "bot-1", notificationsEnabled: true }], rooms: [] });
    await refreshBotSidebar();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    window.history.pushState({}, "", "/bots/bot-1");

    render(<BotRoutineNotifier />);
    fireRoutine(RUN);

    expect(mocks.playSessionCompleteSound).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toEqual([]);
  });

  it("ignores malformed events instead of throwing", async () => {
    render(<BotRoutineNotifier />);
    const source = sources[0];
    if (!source) throw new Error("Routine EventSource was not created");
    act(() => {
      source.listeners.get("routine")?.({ data: "not json" } as MessageEvent);
      source.listeners.get("routine")?.({ data: JSON.stringify({ routineName: "x" }) } as MessageEvent);
    });

    expect(mocks.playSessionCompleteSound).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toEqual([]);
  });
});
