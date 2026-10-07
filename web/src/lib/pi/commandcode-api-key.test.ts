import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import {
  fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore,
  type AuthContext, type Provider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { providerAuthMethods, ProviderLoginSession } from "./auth-login";
import { withCommandCodeApiKeyAuth } from "./commandcode-provider";

const signal = new AbortController().signal;
const ctx: AuthContext = {
  env: async () => "ambient-test-key",
  fileExists: async () => false,
};
function testProvider(): Provider {
  return { ...fauxProvider({ provider: "commandcode" }).provider,
    baseUrl: "https://api.commandcode.ai/provider/v1" };
}
function method(accountScoped = true) {
  return withCommandCodeApiKeyAuth(testProvider(), accountScoped).auth.apiKey!;
}
afterEach(() => vi.unstubAllGlobals());

describe("Command Code API-key authentication", () => {
  it("adds API-key login while preserving OAuth and the stream", () => {
    const base = testProvider();
    const oauth = {} as NonNullable<Provider["auth"]["oauth"]>;
    const provider = withCommandCodeApiKeyAuth({ ...base, auth: { oauth } }, true);
    assert.deepEqual(providerAuthMethods(provider), ["api_key", "oauth"]);
    assert.equal(provider.auth.oauth, oauth);
    assert.equal(provider.streamSimple, base.streamSimple);
    assert.equal(provider.getModels, base.getModels);
  });

  it("does not borrow environment credentials for an empty account", async () => {
    assert.equal(await method().check!({ ctx, signal }), undefined);
    assert.equal(await method().resolve({ ctx, signal }), undefined);
  });

  it("uses a stored account key before environment credentials", async () => {
    for (const scoped of [true, false]) {
      const auth = await method(scoped).resolve({ ctx, signal,
        credential: { type: "api_key", key: " account-test-key " } });
      assert.deepEqual(auth, { auth: { apiKey: "account-test-key" }, source: "stored API key" });
    }
  });

  it("allows either environment name only for the default runtime", async () => {
    for (const name of ["COMMANDCODE_API_KEY", "COMMAND_CODE_API_KEY"]) {
      const envCtx: AuthContext = { ...ctx, env: async (key) => key === name ? "env-test-key" : undefined };
      assert.deepEqual(await method(false).resolve({ ctx: envCtx, signal }), {
        auth: { apiKey: "env-test-key" }, source: name,
      });
    }
  });

  it("validates a masked prompt, saves the selected account and streams with its key", async () => {
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
      modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    const faux = fauxProvider({ provider: "commandcode" });
    faux.setResponses([(_context, options) => {
      assert.equal(options?.apiKey, "account-test-key");
      return fauxAssistantMessage("OK");
    }]);
    runtime.registerNativeProvider(withCommandCodeApiKeyAuth({ ...faux.provider,
      baseUrl: "https://api.commandcode.ai/provider/v1" }, true));
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, "https://api.commandcode.ai/alpha/whoami");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer account-test-key");
      assert.ok(init?.signal);
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    // Registration starts an asynchronous availability pass; finish it before login.
    await runtime.refresh({ providers: ["commandcode"], allowNetwork: false });
    const session = new ProviderLoginSession("commandcode", "api_key", "goat-account");
    let prompted = false;
    session.subscribe((event) => {
      if (event.type === "prompt") {
        assert.equal(event.prompt.type, "secret");
        assert.equal(event.prompt.message, "Command Code API key");
        prompted = true;
        session.answer(event.id, " account-test-key ");
      }
      if (event.type === "done") assert.equal(event.ok, true);
    });
    await session.run(runtime);
    assert.equal(prompted, true);
    assert.deepEqual(await credentials.read("commandcode"), { type: "api_key", key: "account-test-key" });
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.deepEqual(await runtime.checkAuth("commandcode"), { type: "api_key", source: "stored API key" });
    assert.equal(runtime.hasConfiguredAuth("commandcode"), true);
    const model = runtime.getModels("commandcode")[0];
    const response = await runtime.completeSimple(model, { messages: [
      { role: "user", content: "Reply OK", timestamp: Date.now() },
    ] });
    assert.equal(response.stopReason, "stop");
  });

  it("rejects an invalid key without exposing the response or replacing the saved key", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("commandcode", async () => ({ type: "api_key", key: "old-test-key" }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
      modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    runtime.registerNativeProvider(withCommandCodeApiKeyAuth(testProvider(), true));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid-test-key", { status: 401 })));
    await assert.rejects(runtime.login("commandcode", "api_key", {
      prompt: async () => "invalid-test-key", notify: () => {},
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /401/);
      assert.equal(error.message.includes("invalid-test-key"), false);
      return true;
    });
    assert.deepEqual(await credentials.read("commandcode"), { type: "api_key", key: "old-test-key" });
  });

  it("rejects blank keys before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await assert.rejects(method().login!({ signal,
      prompt: async () => "   ", notify: () => {},
    }), /API キーが必要/);
    assert.equal(fetchMock.mock.calls.length, 0);
  });
});
