import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyPushoverCompletion, shouldNotifyPushoverCompletion } from "./pushover";

afterEach(() => vi.restoreAllMocks());

describe("Pushover completion filtering", () => {
  const ready = {
    error: null,
    manuallyAborted: false,
    recovering: false,
    goalLoopRunning: false,
    botNotificationsEnabled: true,
  };

  it("only sends for completed, non-recovering turns with notifications enabled", () => {
    expect(shouldNotifyPushoverCompletion(ready)).toBe(true);
    expect(shouldNotifyPushoverCompletion({ ...ready, error: "failed" })).toBe(false);
    expect(shouldNotifyPushoverCompletion({ ...ready, manuallyAborted: true })).toBe(false);
    expect(shouldNotifyPushoverCompletion({ ...ready, recovering: true })).toBe(false);
    expect(shouldNotifyPushoverCompletion({ ...ready, goalLoopRunning: true })).toBe(false);
    expect(shouldNotifyPushoverCompletion({ ...ready, botNotificationsEnabled: false })).toBe(false);
  });
});

describe("Pushover HTTP delivery", () => {
  const env = {
    LEAFCODE_PI_PUSHOVER_TOKEN: "example-token",
    LEAFCODE_PI_PUSHOVER_USER: "example-user",
  };

  it("stays disabled without both credentials", async () => {
    const send = vi.fn();
    expect(await notifyPushoverCompletion("Task", { env: {}, send })).toBe(false);
    expect(await notifyPushoverCompletion("Task", { env: { ...env, LEAFCODE_PI_PUSHOVER_USER: "" }, send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends title only to the fixed HTTPS endpoint and supports an optional device", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    expect(await notifyPushoverCompletion("  Build done  ", {
      env: { ...env, LEAFCODE_PI_PUSHOVER_DEVICE: "iphone" }, send,
    })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.pushover.net/1/messages.json");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeInstanceOf(URLSearchParams);
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      token: "example-token", user: "example-user", title: "LeafCodePi タスク完了",
      message: "Build done", device: "iphone",
    });
  });

  it("limits the title and never logs credentials or provider responses on failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const send = vi.fn().mockResolvedValue({ ok: false, status: 400, text: () => "secret" });
    expect(await notifyPushoverCompletion("a".repeat(1025), { env, send })).toBe(false);
    const body = send.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("message")).toHaveLength(1024);
    expect(warn).toHaveBeenCalledWith("[pushover] notification failed (HTTP 400)");
    send.mockRejectedValueOnce(new Error("example-token"));
    expect(await notifyPushoverCompletion("Task", { env, send })).toBe(false);
    expect(warn).toHaveBeenLastCalledWith("[pushover] notification failed (storage, network or timeout)");
  });
});
