import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderLoginSession, type LoginSessionEvent } from "./auth-login";
import { forwardOAuthCallback } from "./oauth-callback";

vi.mock("./oauth-callback", async (importOriginal) => ({
  ...await importOriginal<typeof import("./oauth-callback")>(),
  forwardOAuthCallback: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function start(authUrl = "https://example.test/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1456%2Foauth%2Fcallback&state=test-state") {
  const session = new ProviderLoginSession("radius", "oauth", "account-1");
  const events: LoginSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  let finish!: () => void;
  const runtime = { login: async (_provider: string, _type: string, interaction: {
    notify: (event: { type: "auth_url"; url: string }) => void;
  }) => {
    interaction.notify({ type: "auth_url", url: authUrl });
    await new Promise<void>((resolve) => { finish = resolve; });
  } } as unknown as Parameters<typeof session.run>[0];
  const run = session.run(runtime);
  return { session, events, finish: async () => { finish(); await run; } };
}

describe("ProviderLoginSession callback relay", () => {
  it("advertises and relays the provider callback without requiring a native prompt", async () => {
    const { session, events, finish } = await start();
    expect(events).toContainEqual({ type: "notify", event: expect.objectContaining({
      type: "auth_url", callbackUrl: "http://127.0.0.1:1456/oauth/callback",
    }) });
    await session.completeCallback("test-input");
    expect(forwardOAuthCallback).toHaveBeenCalledWith({
      url: "http://127.0.0.1:1456/oauth/callback", state: "test-state",
    }, "test-input", expect.any(AbortSignal));
    // The provider, not the relay response, owns successful token exchange.
    expect(events.some((event) => event.type === "done")).toBe(false);
    await expect(session.completeCallback("test-input")).rejects.toMatchObject({ status: 409 });
    const replay: LoginSessionEvent[] = [];
    session.subscribe((event) => replay.push(event));
    expect(replay).toContainEqual({ type: "notify", event: expect.objectContaining({ callbackUrl: undefined }) });
    await finish();
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
    await expect(session.completeCallback("test-input")).rejects.toMatchObject({ status: 409 });
  });

  it("does not replay consumed native prompts or enable the relay after native submission", async () => {
    const session = new ProviderLoginSession("anthropic", "oauth");
    const events: LoginSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    let finish!: () => void;
    const run = session.run({ login: async (_provider: string, _type: string, interaction: {
      notify: (event: { type: "auth_url"; url: string }) => void;
      prompt: (prompt: { type: "manual_code"; message: string }) => Promise<string>;
    }) => {
      interaction.notify({ type: "auth_url", url: "https://example.test/auth?redirect_uri=http://127.0.0.1:1456/oauth/callback" });
      await interaction.prompt({ type: "manual_code", message: "Paste" });
      await new Promise<void>((resolve) => { finish = resolve; });
    } } as unknown as Parameters<typeof session.run>[0]);
    const prompt = events.find((event) => event.type === "prompt");
    if (!prompt || prompt.type !== "prompt") throw new Error("Missing prompt");
    const before: LoginSessionEvent[] = [];
    session.subscribe((event) => before.push(event))();
    expect(before).toContainEqual(prompt);
    session.answer(prompt.id, "test-code");
    await Promise.resolve();
    const replay: LoginSessionEvent[] = [];
    session.subscribe((event) => replay.push(event))();
    expect(replay.some((event) => event.type === "prompt")).toBe(false);
    expect(replay).toContainEqual({ type: "notify", event: expect.objectContaining({ callbackUrl: undefined }) });
    await expect(session.completeCallback("test-input")).rejects.toMatchObject({ status: 409 });
    finish();
    await run;
  });

  it("allows correction after validation/transport failure", async () => {
    const { session, finish } = await start();
    vi.mocked(forwardOAuthCallback).mockRejectedValueOnce(new Error("invalid URL"));
    await expect(session.completeCallback("wrong")).rejects.toThrow("invalid URL");
    await expect(session.completeCallback("corrected")).resolves.toBeUndefined();
    await finish();
  });

  it("rejects concurrent submissions", async () => {
    const { session, finish } = await start();
    let resolve!: () => void;
    vi.mocked(forwardOAuthCallback).mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const pending = session.completeCallback("test-input");
    await expect(session.completeCallback("test-input")).rejects.toMatchObject({ status: 409 });
    resolve();
    await pending;
    await finish();
  });

  it.each(["cancelled", "expired", "non-loopback"])("rejects a %s callback", async (scenario) => {
    vi.useFakeTimers();
    const { session, finish } = await start(scenario === "non-loopback" ? "https://example.test/device" : undefined);
    if (scenario === "cancelled") session.cancel();
    if (scenario === "expired") vi.advanceTimersByTime(10 * 60_000);
    await expect(session.completeCallback("test-input")).rejects.toMatchObject({ status: 409 });
    expect(forwardOAuthCallback).not.toHaveBeenCalled();
    await finish();
  });
});
