import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBotsEventsHubForTests, subscribeBotsEvents } from "./bots-events-hub";
import { sseReconnectDelayMs } from "./sse-reconnect";

class TestSource {
  static instances: TestSource[] = [];
  listeners = new Map<string, Set<EventListener>>();
  closed = false;
  constructor(public url: string) {
    TestSource.instances.push(this);
  }
  addEventListener(name: string, callback: EventListener) {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(callback);
  }
  removeEventListener(name: string, callback: EventListener) {
    this.listeners.get(name)?.delete(callback);
  }
  close() {
    this.closed = true;
  }
  fire(name: string, data: string) {
    for (const callback of [...(this.listeners.get(name) ?? [])]) {
      callback({ data } as MessageEvent);
    }
  }
  fireOpen() {
    for (const callback of [...(this.listeners.get("open") ?? [])]) {
      callback(new Event("open"));
    }
  }
  fireError() {
    for (const callback of [...(this.listeners.get("error") ?? [])]) {
      callback(new Event("error"));
    }
  }
}

function lastSource(): TestSource {
  const source = TestSource.instances.at(-1);
  if (!source) throw new Error("EventSource was not created");
  return source;
}

beforeEach(() => {
  resetBotsEventsHubForTests();
  TestSource.instances = [];
  vi.stubGlobal("EventSource", TestSource);
});

afterEach(() => {
  resetBotsEventsHubForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bots-events-hub", () => {
  it("shares one EventSource and dispatches each event to its subscribers", () => {
    const dirty = vi.fn();
    const snapshot = vi.fn();
    const stopDirty = subscribeBotsEvents({ events: { task_dirty: dirty } });
    const stopSnapshot = subscribeBotsEvents({ events: { snapshot } });

    expect(TestSource.instances).toHaveLength(1);
    const source = lastSource();
    source.fire("task_dirty", JSON.stringify({ taskId: "task-1" }));
    expect(dirty).toHaveBeenCalledWith({ taskId: "task-1" });
    expect(snapshot).not.toHaveBeenCalled();
    // Only subscribed event names are attached.
    expect(source.listeners.has("routine")).toBe(false);

    source.fire("snapshot", JSON.stringify({ eventType: "code_session_changed" }));
    expect(snapshot).toHaveBeenCalledWith({ eventType: "code_session_changed" });

    stopDirty();
    stopSnapshot();
  });

  it("reports open to a subscriber that joins after the connection opened", () => {
    const firstOpen = vi.fn();
    const stopFirst = subscribeBotsEvents({ onOpen: firstOpen });
    lastSource().fireOpen();
    expect(firstOpen).toHaveBeenCalledTimes(1);

    const lateOpen = vi.fn();
    const stopLate = subscribeBotsEvents({ onOpen: lateOpen });
    expect(lateOpen).toHaveBeenCalledTimes(1);
    expect(TestSource.instances).toHaveLength(1);

    stopFirst();
    stopLate();
  });

  it("closes the source when the last subscriber leaves and reopens for the next", () => {
    const stopFirst = subscribeBotsEvents({ events: { task_dirty: vi.fn() } });
    const first = lastSource();
    stopFirst();
    expect(first.closed).toBe(true);

    const stopSecond = subscribeBotsEvents({ events: { task_dirty: vi.fn() } });
    expect(TestSource.instances).toHaveLength(2);
    expect(lastSource().closed).toBe(false);
    stopSecond();
  });

  it("notifies error, closes and reconnects with backoff", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const onOpen = vi.fn();
    const stop = subscribeBotsEvents({ onOpen, onError });
    const first = lastSource();

    first.fireError();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(first.closed).toBe(true);

    vi.advanceTimersByTime(sseReconnectDelayMs(1));
    expect(TestSource.instances).toHaveLength(2);
    lastSource().fireOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
    stop();
  });

  it("retries with backoff when the EventSource constructor throws", () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal("EventSource", class {
      constructor() {
        attempts += 1;
        if (attempts === 1) throw new Error("transport unavailable");
        return new TestSource("/api/bots/events") as unknown as object;
      }
    });
    const onError = vi.fn();
    const onOpen = vi.fn();
    const stop = subscribeBotsEvents({ onOpen, onError });
    expect(attempts).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(sseReconnectDelayMs(1));
    expect(attempts).toBe(2);
    lastSource().fireOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps a malformed frame from taking down other subscribers", () => {
    const dirty = vi.fn();
    const routine = vi.fn();
    const stopDirty = subscribeBotsEvents({ events: { task_dirty: dirty } });
    const stopRoutine = subscribeBotsEvents({ events: { routine } });

    lastSource().fire("routine", "{not-json");
    expect(routine).toHaveBeenCalledWith(undefined);
    expect(dirty).not.toHaveBeenCalled();

    stopDirty();
    stopRoutine();
  });

  it("creates no source when EventSource is unavailable", () => {
    vi.unstubAllGlobals();
    const stop = subscribeBotsEvents({ events: { task_dirty: vi.fn() } });
    expect(TestSource.instances).toHaveLength(0);
    stop();
  });
});
