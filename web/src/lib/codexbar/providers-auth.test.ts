import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageScope } from "./types";

const auth = vi.hoisted(() => ({
  read: vi.fn(
    (): {
      access: string;
      refresh: null;
      expires: null;
      accountId: null;
    } | null => ({
      access: "token",
      refresh: null,
      expires: null,
      accountId: null,
    }),
  ),
  readApiKey: vi.fn(() => null),
}));

vi.mock("./pi-auth", () => ({
  readPiOAuthTokens: auth.read,
  readPiApiKey: auth.readApiKey,
  writeBackPiOAuthTokens: vi.fn(),
}));

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

import { createAnthropicProvider } from "./providers/anthropic";
import {
  createCommandCodeProvider,
  resolveCommandCodeApiKey,
} from "./providers/commandcode";
import { createCursorProvider } from "./providers/cursor";
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
  auth.read.mockImplementation(() => ({
    access: "token",
    refresh: null,
    expires: null,
    accountId: null,
  }));
  auth.readApiKey.mockClear();
  undiciFetch.mockImplementation(
    async (url: string) =>
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

describe("account-scoped API credentials", () => {
  it("reads the extension's canonical env key for the default scope", () => {
    const previousPrimary = process.env.COMMANDCODE_API_KEY;
    const previousAlternative = process.env.COMMAND_CODE_API_KEY;
    process.env.COMMANDCODE_API_KEY = "canonical-key";
    delete process.env.COMMAND_CODE_API_KEY;
    try {
      expect(resolveCommandCodeApiKey()).toBe("canonical-key");
    } finally {
      if (previousPrimary === undefined) delete process.env.COMMANDCODE_API_KEY;
      else process.env.COMMANDCODE_API_KEY = previousPrimary;
      if (previousAlternative === undefined)
        delete process.env.COMMAND_CODE_API_KEY;
      else process.env.COMMAND_CODE_API_KEY = previousAlternative;
    }
  });

  it("uses the account Command Code credential without ambient env fallback", () => {
    const previous = process.env.COMMAND_CODE_API_KEY;
    process.env.COMMAND_CODE_API_KEY = "ambient-key";
    try {
      auth.read.mockReturnValue(null);
      expect(createCommandCodeProvider(scope).isConfigured()).toBe(false);
      expect(auth.read).toHaveBeenCalledWith("commandcode", {
        authPath: scope.authPath,
      });
    } finally {
      if (previous === undefined) delete process.env.COMMAND_CODE_API_KEY;
      else process.env.COMMAND_CODE_API_KEY = previous;
    }
  });

  it("reads Cursor OAuth from the account auth path", () => {
    auth.read.mockReturnValue({
      access: "token",
      refresh: null,
      expires: null,
      accountId: null,
    });
    const provider = createCursorProvider(scope);
    expect(provider.isConfigured()).toBe(true);
    expect(auth.read).toHaveBeenCalledWith("cursor", {
      authPath: scope.authPath,
    });
  });
});
