import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import {
  ProviderLoginSession,
  SUBSCRIPTION_PROVIDER_IDS,
  isHighlightedProvider,
  providerAuthMethods,
} from "@/lib/pi/auth-login";

describe("ProviderLoginSession", () => {
  it("keeps accountId and reports it on the started event", async () => {
    const session = new ProviderLoginSession("openai-codex", "oauth", "acc-1");
    assert.equal(session.accountId, "acc-1");

    const events: { type: string; accountId?: string | null }[] = [];
    session.subscribe((event) => events.push(event));
    const stubRuntime = {
      login: () => Promise.resolve(),
    } as unknown as Parameters<typeof session.run>[0];
    await session.run(stubRuntime);

    const started = events.find((event) => event.type === "started");
    assert.ok(started);
    assert.equal(started.accountId, "acc-1");
    assert.ok(events.some((event) => event.type === "done"));
  });

  it("defaults accountId to null for the default auth store", async () => {
    const session = new ProviderLoginSession("anthropic", "oauth");
    assert.equal(session.accountId, null);
  });

  it("cleans up the prompt abort listener after an answer", async () => {
    const session = new ProviderLoginSession("anthropic", "oauth");
    const promptAbort = new AbortController();
    const remove = vi.spyOn(promptAbort.signal, "removeEventListener");
    session.subscribe((event) => {
      if (event.type === "prompt") session.answer(event.id, "ok");
    });
    const runtime = {
      login: async (
        _providerId: string,
        _authType: string,
        interaction: {
          prompt: (prompt: {
            type: "text";
            message: string;
            signal: AbortSignal;
          }) => Promise<string>;
        },
      ) => {
        await interaction.prompt({
          type: "text",
          message: "入力",
          signal: promptAbort.signal,
        });
      },
    } as unknown as Parameters<typeof session.run>[0];

    await session.run(runtime);

    assert.ok(
      remove.mock.calls.some(
        ([type, listener]) => type === "abort" && typeof listener === "function",
      ),
    );
  });
});

describe("providerAuthMethods", () => {
  it("lists api_key and oauth when both exist", () => {
    assert.deepEqual(providerAuthMethods({ auth: { apiKey: {}, oauth: {} } }), ["api_key", "oauth"]);
  });

  it("lists oauth-only for ChatGPT subscription provider shape", () => {
    assert.deepEqual(providerAuthMethods({ auth: { oauth: {} } }), ["oauth"]);
  });
});

describe("subscription provider ids", () => {
  it("covers Anthropic and OpenAI Codex", () => {
    assert.ok(SUBSCRIPTION_PROVIDER_IDS.has("anthropic"));
    assert.ok(SUBSCRIPTION_PROVIDER_IDS.has("openai-codex"));
    assert.ok(SUBSCRIPTION_PROVIDER_IDS.has("cursor"));
    assert.equal(SUBSCRIPTION_PROVIDER_IDS.has("openai"), false);
  });

  it("highlights Ollama Cloud and Command Code with subscriptions", () => {
    assert.ok(isHighlightedProvider("ollama-cloud"));
    assert.ok(isHighlightedProvider("commandcode"));
    assert.ok(isHighlightedProvider("anthropic"));
    assert.equal(isHighlightedProvider("openai"), false);
  });
});
