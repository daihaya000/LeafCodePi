// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthPanel } from "./ProviderAuthPanel";

const fetchMock = vi.fn();
let confirmSpy: { mockRestore: () => void } | null = null;

const providers = [
  {
    id: "llama-server",
    name: "llama-server",
    authenticated: false,
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    authenticated: true,
    authSource: "stored",
    oauthAvailable: true,
    highlighted: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    authenticated: true,
    authSource: "stored",
    oauthAvailable: true,
    highlighted: true,
  },
];

const accounts = [
  {
    id: "acc-1",
    label: "仕事用",
    providers: ["openai-codex"],
    note: "メイン",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "acc-2",
    label: "個人用",
    providers: ["anthropic"],
    createdAt: "",
    updatedAt: "",
  },
];

const ollamaProvider = {
  id: "ollama-cloud",
  name: "Ollama Cloud",
  authenticated: false,
  methods: ["api_key"] as ("api_key" | "oauth")[],
  oauthAvailable: false,
  highlighted: true,
  accountRoutingMode: "separate" as const,
};

const ollamaAccount = {
  id: "ollama-acc-1",
  label: "Ollama 個人用",
  providers: ["ollama-cloud"],
  createdAt: "",
  updatedAt: "",
};

const openrouterProvider = {
  id: "openrouter",
  name: "OpenRouter",
  authenticated: true,
  authSource: "environment",
  authLabel: "OPENROUTER_API_KEY",
  methods: ["api_key"] as ("api_key" | "oauth")[],
  oauthAvailable: false,
  highlighted: true,
  accountRoutingMode: "separate" as const,
};

const opencodeGoProvider = {
  id: "opencode-go",
  name: "OpenCode Go",
  authenticated: false,
  methods: [] as ("api_key" | "oauth")[],
  oauthAvailable: false,
  highlighted: true,
  accountRoutingMode: "separate" as const,
};

const opencodeGoAccount = {
  id: "opencode-go-acc-1",
  label: "OpenCode Go 個人用",
  providers: ["opencode-go"],
  createdAt: "",
  updatedAt: "",
};

const endpointProvider = {
  id: "leafcodecloud",
  name: "LeafCodeCloud",
  authenticated: false,
  baseUrl: "https://default.example/v1",
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  confirmSpy?.mockRestore();
  confirmSpy = null;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockAccountsApi(accountList = accounts) {
  fetchMock.mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/accounts")) {
        if (method === "GET")
          return Promise.resolve(jsonResponse({ accounts: accountList }));
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body)) as { accountOrder: string[] };
          const byId = new Map(accountList.map((account) => [account.id, account]));
          return Promise.resolve(
            jsonResponse({
              accounts: body.accountOrder.map((id) => byId.get(id)),
            }),
          );
        }
        if (method === "POST")
          return Promise.resolve(jsonResponse({ account: accounts[0] }));
      }
      const statusMatch = url.match(/\/api\/accounts\/([^/]+)\/auth-status/);
      if (statusMatch) {
        const providerIds = statusMatch[1] === "acc-1" ? ["openai-codex"] : [];
        return Promise.resolve(jsonResponse({ providers: providerIds }));
      }
      return Promise.resolve(jsonResponse({}));
    },
  );
}

async function accountRegion(name: string) {
  return screen.findByRole("region", { name: `${name} の追加アカウント` });
}

describe("ProviderAuthPanel provider-scoped accounts", () => {
  it("edits a provider API URL with PUT", async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ baseUrl: "https://custom.example/v1" })),
    );
    render(
      <ProviderAuthPanel
        providers={[endpointProvider]}
        onChanged={onChanged}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "LeafCodeCloud の API URL",
    });
    fireEvent.change(input, {
      target: { value: "https://custom.example/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/providers/leafcodecloud/base-url"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ baseUrl: "https://custom.example/v1" }),
        }),
      );
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it("skips account loading when no account-managed provider is available", () => {
    render(<ProviderAuthPanel providers={providers.slice(0, 1)} onChanged={() => {}} />);

    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/api/accounts")),
    ).toBe(false);
  });

  it("shows each account only inside its matching provider", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const codex = await accountRegion("OpenAI Codex");
    const anthropic = await accountRegion("Anthropic");
    expect(await within(codex).findByText("仕事用")).toBeTruthy();
    expect(within(codex).queryByText("個人用")).toBeNull();
    expect(within(codex).queryByRole("checkbox", { name: "統合" })).toBeNull();
    expect(await within(anthropic).findByText("個人用")).toBeTruthy();
    expect(within(anthropic).queryByText("仕事用")).toBeNull();
    expect(within(anthropic).queryByRole("checkbox", { name: "統合" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "llama-server の追加アカウント" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "ログインアカウント" })).toBeNull();
  });

  it("keeps long account labels separate from their action buttons", async () => {
    const longLabel = "daihayao000@gmail.com";
    mockAccountsApi([{ ...accounts[0], label: longLabel }]);
    render(
      <ProviderAuthPanel
        providers={[providers[1]]}
        onChanged={() => {}}
      />,
    );

    const codex = await accountRegion("OpenAI Codex");
    const label = await within(codex).findByText(longLabel);
    const accountRow = label.parentElement?.parentElement;
    expect(accountRow?.className).toContain("flex-col");
    expect(
      within(codex).getByRole("button", { name: "再ログイン" }),
    ).toBeTruthy();
  });

  it("reorders provider accounts with an arrow and saves the global order", async () => {
    const accountList = [
      ...accounts,
      {
        id: "acc-3",
        label: "予備用",
        providers: ["openai-codex"],
        createdAt: "",
        updatedAt: "",
      },
    ];
    mockAccountsApi(accountList);
    render(
      <ProviderAuthPanel
        providers={[providers[1]]}
        onChanged={() => {}}
      />,
    );

    const codex = await accountRegion("OpenAI Codex");
    fireEvent.click(
      await within(codex).findByRole("button", { name: "仕事用 を下へ移動" }),
    );

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/accounts") && init?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        accountOrder: ["acc-3", "acc-2", "acc-1"],
      });
    });
  });

  it("changes the routing mode from the provider section", async () => {
    mockAccountsApi([
      ...accounts,
      {
        id: "acc-3",
        label: "予備用",
        providers: ["openai-codex"],
        createdAt: "",
        updatedAt: "",
      },
    ]);
    const onChanged = vi.fn();
    render(
      <ProviderAuthPanel
        providers={providers.map((provider) =>
          provider.id === "openai-codex"
            ? { ...provider, accountRoutingMode: "separate" as const }
            : provider,
        )}
        onChanged={onChanged}
      />,
    );

    const codex = await accountRegion("OpenAI Codex");
    fireEvent.click(within(codex).getByRole("checkbox", { name: "統合" }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/providers/openai-codex") &&
          init?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        accountRoutingMode: "integrated",
      });
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it("uses account controls instead of default authentication", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const anthropic = await accountRegion("Anthropic");
    await within(anthropic).findByText("個人用");
    expect(screen.queryByText("アカウントで管理")).toBeNull();
    expect(within(anthropic).getByRole("heading", { name: "アカウント" })).toBeTruthy();
    expect(screen.queryByText("このプロバイダー用のアカウントを追加・管理します。")).toBeNull();
    expect(screen.queryByText("~/.pi/agent/auth.json")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^ログイン$/ })).toHaveLength(
      1,
    );
    expect(
      within(anthropic).getByRole("button", { name: /^ログイン$/ }),
    ).toBeTruthy();
  });

  it("uses account controls instead of default authentication for API-key providers", async () => {
    mockAccountsApi();
    render(
      <ProviderAuthPanel
        providers={[openrouterProvider]}
        onChanged={() => {}}
      />,
    );

    const openrouter = await accountRegion("OpenRouter");
    expect(
      within(openrouter).getByRole("button", { name: "アカウントを追加" }),
    ).toBeTruthy();
    expect(screen.queryByText("環境変数 OPENROUTER_API_KEY")).toBeNull();
    expect(screen.queryByText("アカウントで管理")).toBeNull();
    expect(screen.queryByRole("button", { name: "API キー" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ログアウト" })).toBeNull();
  });

  it("shows OpenCode Go cookie controls without an unsupported login action", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(
            jsonResponse({ accounts: [opencodeGoAccount] }),
          );
        }
        if (url.endsWith(`/api/accounts/${opencodeGoAccount.id}/auth-status`)) {
          return Promise.resolve(
            jsonResponse({ providers: [], opencodeGoCookieConfigured: false }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel
        providers={[opencodeGoProvider]}
        onChanged={() => {}}
      />,
    );

    const opencodeGo = await accountRegion("OpenCode Go");
    expect(within(opencodeGo).getByText("未登録")).toBeTruthy();
    expect(
      within(opencodeGo).getByRole("button", { name: "登録" }),
    ).toBeTruthy();
    expect(
      within(opencodeGo).queryByRole("button", { name: "ログイン" }),
    ).toBeNull();
  });

  it("shows and uses Codex reset credits from the CodexBar usage snapshot", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const pathname = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (pathname === "/api/accounts") {
          return Promise.resolve(jsonResponse({ accounts: [] }));
        }
        if (pathname === "/api/codexbar/usage") {
          return Promise.resolve(
            jsonResponse({
              providers: [
                {
                  id: "openai-codex",
                  usedPercent: 80,
                  resetCreditsAvailable: 2,
                },
              ],
            }),
          );
        }
        if (pathname === "/api/codexbar/reset-credits" && method === "GET") {
          return Promise.resolve(
            jsonResponse({
              availableCount: 2,
              accountId: null,
              credits: [
                {
                  id: "credit-1",
                  title: "使用量リセット",
                  expiresAt: null,
                },
              ],
            }),
          );
        }
        if (pathname === "/api/codexbar/reset-credits" && method === "POST") {
          return Promise.resolve(
            jsonResponse({ ok: true, message: "リセットしました。" }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel
        providers={[providers[1]]}
        onChanged={() => {}}
      />,
    );

    const resetCredits = await screen.findByText("リセット権");
    expect(resetCredits.parentElement?.textContent).toContain("2");
    expect(screen.getByText("使用量")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Codex の使用量リセット権を使う",
      }),
    );
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([input, requestInit]) =>
          new URL(String(input), "http://localhost").pathname ===
            "/api/codexbar/reset-credits" &&
          (requestInit?.method ?? "GET") === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        creditId: "credit-1",
      });
    });
    expect(await screen.findByText("リセットしました。")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/codexbar/usage?refresh=1"),
      ),
    ).toBe(true);
    confirmSpy.mockRestore();
  });

  it("orders enabled providers like the model catalog", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/provider-models")) {
        return Promise.resolve(
          jsonResponse({
            providers: [
              { id: "anthropic", enabled: true },
              { id: "openai-codex", enabled: true },
              { id: "llama-server", enabled: false },
            ],
          }),
        );
      }
      if (url.endsWith("/api/accounts")) {
        return Promise.resolve(jsonResponse({ accounts: [] }));
      }
      return Promise.resolve(jsonResponse({ providers: [] }));
    });
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const heading = screen.getByRole("heading", { name: "プロバイダー" });
    const providerList = heading.parentElement?.querySelector("ul");
    await waitFor(() => {
      expect(
        Array.from(providerList?.children ?? []).map(
          (row) => row.querySelector("span.text-sm.font-medium")?.textContent,
        ),
      ).toEqual(["Anthropic", "OpenAI Codex"]);
    });
  });

  it("hides unconnected non-highlighted providers", () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const heading = screen.getByRole("heading", { name: "プロバイダー" });
    const providerList = heading.parentElement?.querySelector("ul");
    expect(providerList).toBeTruthy();
    expect(providerList?.className).toContain("lg:grid-cols-2");
    expect(providerList?.className).toContain("items-stretch");
    expect(providerList?.className).not.toContain("overflow-y-auto");
    expect(providerList?.className).not.toContain("max-h-72");
    expect(
      screen.queryByRole("heading", { name: "その他のプロバイダー" }),
    ).toBeNull();
    expect(
      screen.queryByText("llama-server", {
        selector: "span.text-sm.font-medium",
      }),
    ).toBeNull();
  });

  it("keeps connected non-highlighted providers visible", () => {
    mockAccountsApi();
    render(
      <ProviderAuthPanel
        providers={[
          {
            id: "minor-connected",
            name: "接続済みプロバイダー",
            authenticated: true,
            highlighted: false,
          },
          {
            id: "minor-unconnected",
            name: "未接続プロバイダー",
            authenticated: false,
            highlighted: false,
          },
        ]}
        onChanged={() => {}}
      />,
    );

    expect(
      screen.getByText("接続済みプロバイダー", {
        selector: "span.text-sm.font-medium",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByText("未接続プロバイダー", {
        selector: "span.text-sm.font-medium",
      }),
    ).toBeNull();
  });

  it("creates an account for the provider whose add action was used", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const anthropic = await accountRegion("Anthropic");
    fireEvent.click(
      within(anthropic).getByRole("button", { name: "アカウントを追加" }),
    );
    fireEvent.change(within(anthropic).getByLabelText("アカウント名"), {
      target: { value: "新規 Claude" },
    });
    fireEvent.click(within(anthropic).getByRole("button", { name: "追加" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/accounts") &&
          (init?.method ?? "GET") === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        label: "新規 Claude",
        providers: ["anthropic"],
      });
    });
  });

  it("starts OAuth login with the selected provider account", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const codex = await accountRegion("OpenAI Codex");
    await within(codex).findByText("仕事用");
    fireEvent.click(
      await within(codex).findByRole("button", { name: "再ログイン" }),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/providers/openai-codex/login") &&
            String(input).includes("accountId=acc-1") &&
            init?.method === "POST",
        ),
      ).toBe(true);
    });
  });

  it("deletes only after confirmation", async () => {
    mockAccountsApi();
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const codex = await accountRegion("OpenAI Codex");
    await within(codex).findByText("仕事用");
    fireEvent.click(within(codex).getByRole("button", { name: "削除" }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes("/api/accounts/acc-1") &&
          (init?.method ?? "") === "DELETE",
      );
      expect(del).toBeTruthy();
    });
  });

  it("registers an Ollama cookie for the selected account", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [ollamaAccount] }));
        }
        if (url.endsWith(`/api/accounts/${ollamaAccount.id}/auth-status`)) {
          return Promise.resolve(
            jsonResponse({ providers: [], ollamaCookieConfigured: false }),
          );
        }
        if (
          url.endsWith(`/api/accounts/${ollamaAccount.id}/ollama-cookie`) &&
          method === "POST"
        ) {
          return Promise.resolve(jsonResponse({ ok: true, configured: true }));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[ollamaProvider]} onChanged={() => {}} />,
    );

    const ollama = await accountRegion("Ollama Cloud");
    expect(within(ollama).getByText("未登録")).toBeTruthy();
    fireEvent.click(within(ollama).getByRole("button", { name: "登録" }));
    const cookieInput = within(ollama).getByLabelText("Netscape 形式の cookie");
    fireEvent.change(cookieInput, {
      target: { value: "# Netscape HTTP Cookie File\n" },
    });
    fireEvent.click(within(ollama).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const save = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith(
            `/api/accounts/${ollamaAccount.id}/ollama-cookie`,
          ) && init?.method === "POST",
      );
      expect(save).toBeTruthy();
      expect(JSON.parse(String(save?.[1]?.body))).toEqual({
        cookies: "# Netscape HTTP Cookie File\n",
      });
    });
  });

  it("starts API-key login for an Ollama account", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [ollamaAccount] }));
        }
        if (url.endsWith(`/api/accounts/${ollamaAccount.id}/auth-status`)) {
          return Promise.resolve(
            jsonResponse({ providers: [], ollamaCookieConfigured: false }),
          );
        }
        if (
          url.includes(`/api/providers/ollama-cloud/login`) &&
          method === "POST"
        ) {
          return Promise.resolve(jsonResponse({}));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[ollamaProvider]} onChanged={() => {}} />,
    );

    const ollama = await accountRegion("Ollama Cloud");
    fireEvent.click(within(ollama).getByRole("button", { name: "ログイン" }));

    await waitFor(() => {
      const login = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes(`/api/providers/ollama-cloud/login`) &&
          init?.method === "POST",
      );
      expect(login).toBeTruthy();
      expect(String(login?.[0])).toContain("accountId=ollama-acc-1");
      expect(JSON.parse(String(login?.[1]?.body))).toEqual({ type: "api_key" });
    });
  });
});
