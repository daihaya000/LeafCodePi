import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SUBSCRIPTION_PROVIDER_IDS, isHighlightedProvider, providerAuthMethods } from "@/lib/pi/auth-login";

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

  it("highlights Ollama Cloud with subscriptions", () => {
    assert.ok(isHighlightedProvider("ollama-cloud"));
    assert.ok(isHighlightedProvider("anthropic"));
    assert.equal(isHighlightedProvider("openai"), false);
  });
});
