import { hostname } from "node:os";
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
    const serverName = Array.from(hostname().trim()).slice(0, 64).join("");
    expect(Object.fromEntries(body)).toEqual({
      token: "example-token", user: "example-user",
      title: serverName ? `LCP ${serverName} タスク完了` : "LCP タスク完了",
      message: "Build done", device: "iphone",
    });
  });

  it.each([
    [{ id: "code a", kind: "code" }, "http://100.64.0.1:3333/task/code%20a"],
    [{ id: "bot:one", kind: "bot", botId: "one" }, "http://100.64.0.1:3333/bots/one"],
    [{ id: "bot:one:room:room 1", kind: "bot", botId: "one" }, "http://100.64.0.1:3333/bots/rooms/room%201"],
    [{ id: "code-owned", kind: "code", botId: "one" }, "http://100.64.0.1:3333/bots/one"],
  ])("includes a clickable link to the task's WebUI surface", async (task, expectedUrl) => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    await notifyPushoverCompletion("Build done", {
      env: { ...env, LEAFCODE_PI_HOST: "100.64.0.1", LEAFCODE_PI_PORT: "3333" }, send, task,
    });
    const body = send.mock.calls[0]![1].body as URLSearchParams;
    expect(body.get("message")).toBe(`Build done\n${expectedUrl}`);
    expect(body.get("url")).toBe(expectedUrl);
    expect(body.get("url_title")).toBe("セッションを開く");
  });

  it("supports an explicit HTTPS origin and skips invalid or unreachable links", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const task = { id: "code a", kind: "code" };
    await notifyPushoverCompletion("Done", {
      env: { ...env, LEAFCODE_PI_PUBLIC_URL: "https://pi.example.test/" }, send, task,
    });
    expect((send.mock.calls[0]![1].body as URLSearchParams).get("url")).toBe("https://pi.example.test/task/code%20a");
    await notifyPushoverCompletion("Done", {
      env: { ...env, LEAFCODE_PI_HOST: "0.0.0.0" }, send, task,
    });
    expect(Object.fromEntries(send.mock.calls[1]![1].body as URLSearchParams)).not.toHaveProperty("url");
    await notifyPushoverCompletion("Done", {
      env: { ...env, LEAFCODE_PI_PUBLIC_URL: "javascript:alert(1)" }, send, task,
    });
    expect(Object.fromEntries(send.mock.calls[2]![1].body as URLSearchParams)).not.toHaveProperty("url");
  });

  it("keeps long titles within Pushover's message limit when a URL is included", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    await notifyPushoverCompletion("a".repeat(1025), {
      env: { ...env, LEAFCODE_PI_HOST: "100.64.0.1" }, send,
      task: { id: "task-1" },
    });
    const body = send.mock.calls[0]![1].body as URLSearchParams;
    expect(body.get("message")).toHaveLength(1024);
    expect(body.get("message")).toContain("\nhttp://100.64.0.1:3000/task/task-1");
  });

  it("also labels test notifications with the server name", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    expect(await notifyPushoverCompletion("テスト", { env, send, title: "テスト通知" })).toBe(true);
    const body = send.mock.calls[0]![1].body as URLSearchParams;
    const serverName = Array.from(hostname().trim()).slice(0, 64).join("");
    expect(body.get("title")).toBe(serverName
      ? `LCP ${serverName} テスト通知`
      : "LCP テスト通知");
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
