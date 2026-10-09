import { afterEach, expect, it, vi } from "vitest";
import { createProviderLoginStream, readProviderLoginStreamDiagnostics as stats } from "@backend-runtime/json-business/provider-login-stream";
import { ProviderLoginSession, type LoginSessionEvent } from "@backend-runtime/lib/pi/auth-login";
const active = () => ({ providerId: "p", sessionId: "s", authType: "oauth", accountId: null });
afterEach(() => { vi.useRealTimers(); expect(stats()).toMatchObject({ active: 0, subscriptions: 0, queuedBytes: 0, heartbeats: 0, stallTimers: 0 }); });
it("drains synchronous completed replay before EOF and unsubscribes exactly once", async () => {
  const off = vi.fn();
  const result = createProviderLoginStream(new AbortController().signal, "p", "s", { active, subscribe(listener) { listener({ type: "notify", event: { type: "info", message: "public" } }); listener({ type: "done", ok: true }); return off; } });
  expect(off).toHaveBeenCalledOnce(); const text = await result.text();
  expect(text).toMatch(/event: started[\s\S]*event: notify[\s\S]*event: done/); expect(text).toContain('"ok":true');
});
it("stale sessions drain a safe terminal event without consulting the SDK", async () => {
  const subscribe = vi.fn(); const result = createProviderLoginStream(new AbortController().signal, "p", "old", { active, subscribe });
  expect(await result.text()).toContain('"ok":false'); expect(subscribe).not.toHaveBeenCalled();
});
it("caps subscribers at 32 and releases preabort/cancel without canceling authentication", async () => {
  const off = vi.fn(), subscribe = vi.fn(() => off), source = { active, subscribe }, c = new AbortController(); c.abort();
  await createProviderLoginStream(c.signal, "p", "s", source).text(); expect(subscribe).not.toHaveBeenCalled();
  const streams = Array.from({ length: 32 }, () => createProviderLoginStream(new AbortController().signal, "p", "s", source));
  expect(createProviderLoginStream(new AbortController().signal, "p", "s", source).status).toBe(503); expect(stats().active).toBe(32);
  await Promise.all(streams.map(r => r.body!.cancel())); expect(off).toHaveBeenCalledTimes(32);
});
it("bounds slow-reader queue/global queue and leaves the producer usable", async () => {
  const listeners: Array<(e: any) => void> = [], off = vi.fn();
  const streams = Array.from({ length: 24 }, () => createProviderLoginStream(new AbortController().signal, "p", "s", { active, subscribe(listener) { listeners.push(listener); return off; } }));
  for (let i = 0; i < 100; i++) for (const fn of listeners) fn({ type: "notify", event: { type: "progress", message: "x".repeat(16000) } });
  expect(stats().queuedBytes).toBeLessThanOrEqual(16 * 1024 * 1024); expect(stats().overflows).toBeGreaterThan(0); expect(off).toHaveBeenCalled();
  await Promise.all(streams.map(s => s.body!.cancel()));
  expect(await createProviderLoginStream(new AbortController().signal, "p", "old", { active, subscribe: () => off }).text()).toContain('"ok":false');
});
it("producer notifications cannot extend the non-reading consumer's stall deadline", async () => {
  vi.useFakeTimers(); let emit!: (e: any) => void; const off = vi.fn();
  const result = createProviderLoginStream(new AbortController().signal, "p", "s", { active, subscribe(fn) { emit = fn; return off; } }, { stallMs: 50, heartbeatMs: 10 });
  await vi.advanceTimersByTimeAsync(40); emit({ type: "notify", event: { type: "progress", message: "later" } });
  await vi.advanceTimersByTimeAsync(11); expect(off).toHaveBeenCalledOnce(); expect(stats().active).toBe(0); await result.body!.cancel();
});
it("bounds projected Unicode/escaped events before encoding and releases synchronous overflow", async () => {
  const off = vi.fn(); const result = createProviderLoginStream(new AbortController().signal, "p", "s", { active, subscribe(fn) { fn({ type: "notify", event: { type: "progress", message: "\u0001".repeat(32768) } }); return off; } });
  expect(await result.text()).not.toContain("event: notify"); expect(off).toHaveBeenCalledOnce();
});
it("coalesces a 20000-event login history while retaining current prompt and auth URL", async () => {
  const session = new ProviderLoginSession("p", "oauth"), events: LoginSessionEvent[] = []; session.subscribe(e => events.push(e));
  let notify!: (e: any) => void, answer: string | undefined;
  const run = session.run({ login: async (_p: any, _t: any, io: any) => {
    notify = io.notify; io.notify({ type: "auth_url", url: "https://example.test/auth?redirect_uri=http://127.0.0.1:1456/callback&state=s" });
    answer = await io.prompt({ type: "manual_code", message: "Paste" });
  } } as never);
  const prompt = events.find(e => e.type === "prompt")! as Extract<LoginSessionEvent, { type: "prompt" }>;
  for (let i = 0; i < 20000; i++) notify({ type: "progress", message: "notification-" + i });
  const replay: LoginSessionEvent[] = [], off = session.subscribe(e => replay.push(e)); off();
  expect(session.readDiagnostics().historyEntries).toBeLessThanOrEqual(7); expect(session.readDiagnostics().historyBytes).toBeLessThan(512 * 1024);
  expect(replay).toContainEqual(prompt); expect(JSON.stringify(replay)).toContain("notification-19999"); expect(JSON.stringify(replay)).not.toContain("notification-19998"); expect(JSON.stringify(replay)).toContain("callbackUrl");
  session.answer(prompt.id, "fixture-code"); await run; const terminal: LoginSessionEvent[] = []; session.subscribe(e => terminal.push(e));
  expect(terminal.some(e => e.type === "prompt")).toBe(false); expect(terminal.at(-1)).toEqual({ type: "done", ok: true }); expect(JSON.stringify(terminal)).not.toContain("fixture-code");
});
it("rejects oversized pending prompts without retaining SDK options or secret failures", async () => {
  const session = new ProviderLoginSession("p", "oauth");
  await session.run({ login: async (_p: any, _t: any, io: any) => { await io.prompt({ type: "select", message: "choice", options: Array.from({ length: 129 }, () => ({ id: "x", label: "x" })) }); } } as never);
  expect(session.readDiagnostics()).toMatchObject({ pending: false, finished: true });
  const replay: LoginSessionEvent[] = []; session.subscribe(e => replay.push(e)); expect(replay.at(-1)).toEqual({ type: "done", ok: false, error: "ログインに失敗しました" });
});
