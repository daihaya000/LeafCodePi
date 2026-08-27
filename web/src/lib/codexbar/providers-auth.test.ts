import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageScope } from "./types";

const auth = vi.hoisted(() => ({
  read: vi.fn(() => ({
    access: "token",
    refresh: null,
    expires: null,
    accountId: null,
  })),
}));

vi.mock("./pi-auth", () => ({
  readPiOAuthTokens: auth.read,
  writeBackPiOAuthTokens: vi.fn(),
}));

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

import { createAnthropicProvider } from "./providers/anthropic";
import { createOpenaiCodexProvider } from "./providers/openai-codex";

const scope: UsageScope = {
  key: "account:test",
  kind: "account",
  accountId: "test",
  accountLabel: "テスト",
  authPath: "/tmp/auth.json",
};

beforeEach(() => {
  auth.read.mockClear();
  undiciFetch.mockImplementation(async (url: string) =>
    new Response(
      url.includes("anthropic")
        ? JSON.stringify({ five_hour: { utilization: 10 } })
        : JSON.stringify({ rate_limit: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
});

afterEach(() => undiciFetch.mockReset());

describe.each([
  ["Codex", createOpenaiCodexProvider],
  ["Claude", createAnthropicProvider],
])("%s account provider", (_name, createProvider) => {
  it("reuses credentials between configuration check and fetch", async () => {
    const provider = createProvider(scope);

    expect(provider.isConfigured()).toBe(true);
    await provider.fetch();

    expect(auth.read).toHaveBeenCalledOnce();
  });
});
