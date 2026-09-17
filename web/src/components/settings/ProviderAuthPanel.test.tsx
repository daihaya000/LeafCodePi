// @vitest-environment happy-dom
import {
  act,
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
    enabled: true,
    note: "メイン",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "acc-2",
    label: "個人用",
    providers: ["anthropic"],
    enabled: true,
    createdAt: "",
    updatedAt: "",
  },
];

const typesafeProvider = {
  id: "typesafe",
  name: "TypeSafe",
  authenticated: false,
  methods: ["api_key"] as ("api_key" | "oauth")[],
  oauthAvailable: false,
  highlighted: true,
};

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
  enabled: true,
  createdAt: "",
  updatedAt: "",
};

/** Anthropic はサブスク（OAuth）と API キーの両方で登録できる。 */
const anthropicProvider = {
  id: "anthropic",
  name: "Anthropic",
  authenticated: true,
  authSource: "stored",
  methods: ["api_key", "oauth"] as ("api_key" | "oauth")[],
  oauthAvailable: true,
  highlighted: true,
  accountRoutingMode: "separate" as const,
};

const anthropicAccount = {
  id: "anthropic-acc-1",
  label: "API 個人用",
  providers: ["anthropic"],
  enabled: true,
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
  enabled: true,
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

  it("registers and removes the shared TypeSafe Console cookie", async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/typesafe-cookie") && method === "GET") {
          return Promise.resolve(jsonResponse({ configured: false }));
        }
        if (url.endsWith("/api/typesafe-cookie") && method === "POST") {
          return Promise.resolve(jsonResponse({ ok: true, configured: true }));
        }
        if (url.endsWith("/api/typesafe-cookie") && method === "DELETE") {
          return Promise.resolve(jsonResponse({ ok: true, configured: false }));
        }
        if (url.endsWith("/api/typesafe-baseline") && method === "GET") {
          return Promise.resolve(jsonResponse({ baselineUsd: null }));
        }
        if (url.endsWith("/api/typesafe-baseline") && method === "POST") {
          return Promise.resolve(jsonResponse({ ok: true, baselineUsd: 5 }));
        }
        if (url.endsWith("/api/typesafe-baseline") && method === "DELETE") {
          return Promise.resolve(jsonResponse({ ok: true, baselineUsd: null }));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProviderAuthPanel providers={[typesafeProvider]} onChanged={onChanged} />);

    const card = screen.getByText("TypeSafe Console cookie").closest("li")!;
    expect(await within(card).findByText("実残高表示には cookie が必要です")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "登録" }));
    fireEvent.change(within(card).getByLabelText("Netscape 形式の cookie"), {
      target: {
        value:
          "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n" +
          "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg_1\n",
      },
    });
    fireEvent.click(
      within(
        within(card).getByLabelText("Netscape 形式の cookie").closest("form")!,
      ).getByRole("button", { name: "保存" }),
    );

    await waitFor(() => {
      const save = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/typesafe-cookie") &&
          init?.method === "POST",
      );
      expect(save).toBeTruthy();
      expect(JSON.parse(String(save?.[1]?.body))).toEqual({
        cookies:
          "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n" +
          "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg_1\n",
      });
      expect(within(card).getByText("実残高を表示できます")).toBeTruthy();
    });

    const baselineInput = within(card).getByLabelText(/基準残高/);
    fireEvent.change(baselineInput, { target: { value: "5" } });
    fireEvent.submit(baselineInput.closest("form")!);
    await waitFor(() => {
      const save = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/typesafe-baseline") &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(save?.[1]?.body))).toEqual({ baselineUsd: 5 });
      expect(within(card).getByRole("button", { name: "解除" })).toBeTruthy();
    });

    fireEvent.click(within(card).getByRole("button", { name: "解除" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/typesafe-baseline") &&
            init?.method === "DELETE",
        ),
      ).toBe(true);
    });

    fireEvent.click(within(card).getByRole("button", { name: "削除" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/typesafe-cookie") &&
            init?.method === "DELETE",
        ),
      ).toBe(true);
      expect(within(card).getByText("実残高表示には cookie が必要です")).toBeTruthy();
    });
  });

  it("does not overwrite a baseline being typed while its initial value loads", async () => {
    let resolveBaseline!: (response: Response) => void;
    const baselineResponse = new Promise<Response>((resolve) => {
      resolveBaseline = resolve;
    });
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/typesafe-cookie") && method === "GET") {
          return Promise.resolve(jsonResponse({ configured: false }));
        }
        if (url.endsWith("/api/typesafe-baseline") && method === "GET") {
          return baselineResponse;
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(<ProviderAuthPanel providers={[typesafeProvider]} onChanged={() => {}} />);

    const input = screen.getByLabelText(/基準残高/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    await act(async () => {
      resolveBaseline(jsonResponse({ baselineUsd: 5 }));
    });

    await waitFor(() => expect(input.value).toBe("10"));
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

  it("ignores an older account refresh after creating an account", async () => {
    let resolveInitialAccounts!: (response: Response) => void;
    const initialAccounts = new Promise<Response>((resolve) => {
      resolveInitialAccounts = resolve;
    });
    let accountGetCount = 0;
    const freshAccount = {
      ...accounts[0],
      id: "acc-fresh",
      label: "追加直後",
    };
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/accounts") && method === "GET") {
        accountGetCount += 1;
        return accountGetCount === 1
          ? initialAccounts
          : Promise.resolve(jsonResponse({ accounts: [freshAccount] }));
      }
      if (url.endsWith("/api/accounts") && method === "POST") {
        return Promise.resolve(jsonResponse({ account: freshAccount }));
      }
      if (url.includes("/auth-status")) {
        return Promise.resolve(jsonResponse({ providers: ["openai-codex"] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ProviderAuthPanel providers={[providers[1]]} onChanged={() => {}} />);
    await waitFor(() => expect(accountGetCount).toBe(1));

    const codex = await accountRegion("OpenAI Codex");
    fireEvent.click(within(codex).getByRole("button", { name: "アカウントを追加" }));
    fireEvent.change(screen.getByLabelText("アカウント名"), {
      target: { value: "新規" },
    });
    fireEvent.click(within(codex).getByRole("button", { name: "追加" }));

    expect(await within(codex).findByText("追加直後")).toBeTruthy();
    await act(async () => {
      resolveInitialAccounts(jsonResponse({ accounts }));
    });
    await waitFor(() => expect(within(codex).queryByText("仕事用")).toBeNull());
    expect(within(codex).getByText("追加直後")).toBeTruthy();
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
        enabled: true,
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
        enabled: true,
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

  it("toggles account availability with the account PATCH API", async () => {
    const onChanged = vi.fn();
    mockAccountsApi();
    render(<ProviderAuthPanel providers={[providers[1]]} onChanged={onChanged} />);

    const codex = await accountRegion("OpenAI Codex");
    fireEvent.click(
      within(codex).getByRole("switch", { name: "仕事用を使用" }),
    );

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/accounts/acc-1") &&
          init?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ enabled: false });
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it("marks paused accounts and renders the switch off", async () => {
    mockAccountsApi([{ ...accounts[0], enabled: false }]);
    render(<ProviderAuthPanel providers={[providers[1]]} onChanged={() => {}} />);

    const codex = await accountRegion("OpenAI Codex");
    expect(within(codex).getByText("一時停止中")).toBeTruthy();
    expect(
      within(codex)
        .getByRole("switch", { name: "仕事用を使用" })
        .getAttribute("aria-checked"),
    ).toBe("false");
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
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
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
                  expiresAt: soon,
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
    expect(
      await screen.findByText("リセット権: 最短期限まであと2日"),
    ).toBeTruthy();
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

  it("ignores events from a previous login session", async () => {
    class TestEventSource extends EventTarget {
      static instances: TestEventSource[] = [];
      closed = false;
      constructor() {
        super();
        TestEventSource.instances.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", TestEventSource);
    let loginCount = 0;
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [accounts[0]] }));
        }
        if (url.endsWith("/api/accounts/acc-1/auth-status")) {
          return Promise.resolve(jsonResponse({ providers: ["openai-codex"] }));
        }
        if (
          url.includes("/api/providers/openai-codex/login") &&
          method === "POST"
        ) {
          loginCount += 1;
          return Promise.resolve(
            jsonResponse({ sessionId: `session-${loginCount}` }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[providers[1]]} onChanged={() => {}} />,
    );

    const codex = await accountRegion("OpenAI Codex");
    fireEvent.click(
      await within(codex).findByRole("button", { name: "再ログイン" }),
    );
    await waitFor(() => {
      expect(TestEventSource.instances).toHaveLength(1);
    });
    const first = TestEventSource.instances[0];
    if (!first) throw new Error("Initial EventSource was not created");

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(first.closed).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "キャンセル" })).toBeNull(),
    );

    fireEvent.click(
      await within(codex).findByRole("button", { name: "再ログイン" }),
    );
    await waitFor(() => {
      expect(TestEventSource.instances).toHaveLength(2);
    });
    const second = TestEventSource.instances[1];
    if (!second) throw new Error("Replacement EventSource was not created");

    await act(async () => {
      first.dispatchEvent(
        new MessageEvent("notify", {
          data: JSON.stringify({
            type: "notify",
            event: { type: "info", message: "古いログイン" },
          }),
        }),
      );
      second.dispatchEvent(
        new MessageEvent("notify", {
          data: JSON.stringify({
            type: "notify",
            event: { type: "info", message: "新しいログイン" },
          }),
        }),
      );
    });

    expect(await screen.findByText("新しいログイン")).toBeTruthy();
    expect(screen.queryByText("古いログイン")).toBeNull();
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

  it("offers subscription and API-key logins for an Anthropic account", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [anthropicAccount] }));
        }
        if (url.endsWith(`/api/accounts/${anthropicAccount.id}/auth-status`)) {
          return Promise.resolve(jsonResponse({ providers: ["anthropic"] }));
        }
        if (url.includes("/api/providers/anthropic/login") && method === "POST") {
          return Promise.resolve(jsonResponse({}));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[anthropicProvider]} onChanged={() => {}} />,
    );

    const anthropic = await accountRegion("Anthropic");
    expect(
      within(anthropic).getByRole("button", { name: "サブスクでログイン" }),
    ).toBeTruthy();
    fireEvent.click(within(anthropic).getByRole("button", { name: "API キー" }));

    await waitFor(() => {
      const login = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes(`/api/providers/anthropic/login`) &&
          init?.method === "POST",
      );
      expect(login).toBeTruthy();
      expect(String(login?.[0])).toContain(`accountId=${anthropicAccount.id}`);
      expect(JSON.parse(String(login?.[1]?.body))).toEqual({ type: "api_key" });
    });
  });

  it("registers an Anthropic Console cookie for the credit balance", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [anthropicAccount] }));
        }
        if (url.endsWith(`/api/accounts/${anthropicAccount.id}/auth-status`)) {
          return Promise.resolve(
            jsonResponse({
              providers: ["anthropic"],
              credentialKinds: { anthropic: "api_key" },
              anthropicCookieConfigured: false,
            }),
          );
        }
        if (
          url.endsWith(`/api/accounts/${anthropicAccount.id}/anthropic-cookie`) &&
          method === "POST"
        ) {
          return Promise.resolve(jsonResponse({ ok: true, configured: true }));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[anthropicProvider]} onChanged={() => {}} />,
    );

    const anthropic = await accountRegion("Anthropic");
    expect(within(anthropic).getByText("Anthropic Console cookie")).toBeTruthy();
    expect(within(anthropic).getByText("未登録")).toBeTruthy();
    fireEvent.click(within(anthropic).getByRole("button", { name: "登録" }));
    fireEvent.change(within(anthropic).getByLabelText("Netscape 形式の cookie"), {
      target: { value: "# Netscape HTTP Cookie File\n" },
    });
    fireEvent.click(within(anthropic).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const save = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith(
            `/api/accounts/${anthropicAccount.id}/anthropic-cookie`,
          ) && init?.method === "POST",
      );
      expect(save).toBeTruthy();
      expect(JSON.parse(String(save?.[1]?.body))).toEqual({
        cookies: "# Netscape HTTP Cookie File\n",
      });
    });
  });

  it("shows the API credit balance for an API-key account", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const pathname = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (pathname === "/api/accounts" && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [anthropicAccount] }));
        }
        if (pathname === `/api/accounts/${anthropicAccount.id}/auth-status`) {
          return Promise.resolve(
            jsonResponse({ providers: ["anthropic"], anthropicCookieConfigured: true }),
          );
        }
        if (pathname === "/api/codexbar/usage") {
          return Promise.resolve(
            jsonResponse({
              providers: [
                {
                  id: "anthropic",
                  accountId: anthropicAccount.id,
                  accountLabel: anthropicAccount.label,
                  usedPercent: null,
                  credits: {
                    title: "API クレジット",
                    used: null,
                    limit: null,
                    balance: 12.34,
                  },
                  windows: [],
                },
              ],
            }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[anthropicProvider]} onChanged={() => {}} />,
    );

    const anthropic = await accountRegion("Anthropic");
    expect(await within(anthropic).findByText("API クレジット")).toBeTruthy();
    expect(within(anthropic).getByText("残高 $12.34")).toBeTruthy();
    // 使用量%が無い口座では使用量バーを出さない
    expect(within(anthropic).queryByText("使用量")).toBeNull();
  });

  it("hides the Console cookie controls for a subscription account", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const pathname = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (pathname === "/api/accounts" && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [anthropicAccount] }));
        }
        if (pathname === `/api/accounts/${anthropicAccount.id}/auth-status`) {
          return Promise.resolve(
            jsonResponse({
              providers: ["anthropic"],
              credentialKinds: { anthropic: "oauth" },
            }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[anthropicProvider]} onChanged={() => {}} />,
    );

    const anthropic = await accountRegion("Anthropic");
    await within(anthropic).findByText("API 個人用");
    // サブスク（OAuth）口座は Console cookie が不要なので欄自体を出さない
    await waitFor(() => {
      expect(within(anthropic).queryByText("Anthropic Console cookie")).toBeNull();
    });
  });

  it("saves the API credit baseline so the balance yields a percentage", async () => {
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const pathname = new URL(url, "http://localhost").pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (pathname === "/api/accounts" && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [anthropicAccount] }));
        }
        if (pathname === `/api/accounts/${anthropicAccount.id}/auth-status`) {
          return Promise.resolve(
            jsonResponse({
              providers: ["anthropic"],
              credentialKinds: { anthropic: "api_key" },
              anthropicCookieConfigured: true,
              anthropicCreditBaseline: 100,
            }),
          );
        }
        if (
          pathname ===
            `/api/accounts/${anthropicAccount.id}/anthropic-baseline` &&
          method === "POST"
        ) {
          return Promise.resolve(jsonResponse({ ok: true, baselineUsd: 50 }));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[anthropicProvider]} onChanged={() => {}} />,
    );

    const anthropic = await accountRegion("Anthropic");
    await waitFor(() => {
      expect(
        (within(anthropic).getByLabelText(/API 基準残高/) as HTMLInputElement)
          .value,
      ).toBe("100");
    });
    expect(within(anthropic).getByText("基準 $100.00")).toBeTruthy();

    // state 更新でノードが差し替わるため、操作の直前に取り直す。
    fireEvent.change(within(anthropic).getByLabelText(/API 基準残高/), {
      target: { value: "50" },
    });
    // happy-dom は number 入力を持つ form の暗黙 submit を行わないため、form へ直接 submit する
    // （クリックでの送信自体は cookie 登録フォームのテストでカバー済み）。
    const form = (
      within(anthropic).getByLabelText(/API 基準残高/) as HTMLInputElement
    ).closest("form");
    fireEvent.submit(form!);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([input2, init]) =>
          new URL(String(input2), "http://localhost").pathname ===
            `/api/accounts/${anthropicAccount.id}/anthropic-baseline` &&
          init?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ baselineUsd: 50 });
    });

    // 解除は DELETE を送る
    fireEvent.click(
      within(anthropic).getByRole("button", {
        name: `${anthropicAccount.label} の基準残高を解除`,
      }),
    );
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        ([input2, init]) =>
          new URL(String(input2), "http://localhost").pathname ===
            `/api/accounts/${anthropicAccount.id}/anthropic-baseline` &&
          init?.method === "DELETE",
      );
      expect(del).toBeTruthy();
    });
  });

  it("surfaces a closed login EventSource as a failed login", async () => {
    class TestEventSource extends EventTarget {
      static instances: TestEventSource[] = [];
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = TestEventSource.OPEN;
      closed = false;
      onerror: ((ev: Event) => void) | null = null;
      constructor() {
        super();
        TestEventSource.instances.push(this);
      }
      close() {
        this.closed = true;
        this.readyState = TestEventSource.CLOSED;
      }
    }
    vi.stubGlobal("EventSource", TestEventSource);
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [accounts[0]] }));
        }
        if (url.endsWith("/api/accounts/acc-1/auth-status")) {
          return Promise.resolve(jsonResponse({ providers: ["openai-codex"] }));
        }
        if (
          url.includes("/api/providers/openai-codex/login") &&
          method === "POST"
        ) {
          return Promise.resolve(jsonResponse({ sessionId: "session-err" }));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[providers[1]]} onChanged={() => {}} />,
    );
    const codex = await accountRegion("OpenAI Codex");
    fireEvent.click(
      await within(codex).findByRole("button", { name: "再ログイン" }),
    );
    await waitFor(() => {
      expect(TestEventSource.instances).toHaveLength(1);
    });
    const source = TestEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");
    source.readyState = TestEventSource.CLOSED;
    await act(async () => {
      source.onerror?.(new Event("error"));
    });
    await waitFor(() => {
      expect(screen.getByText("ログインイベント接続に失敗しました")).toBeTruthy();
    });
  });

  it("opens an auth URL only once across replayed login notify events", async () => {
    class TestEventSource extends EventTarget {
      static instances: TestEventSource[] = [];
      closed = false;
      constructor() {
        super();
        TestEventSource.instances.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("EventSource", TestEventSource);
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [accounts[0]] }));
        }
        if (url.endsWith("/api/accounts/acc-1/auth-status")) {
          return Promise.resolve(jsonResponse({ providers: ["openai-codex"] }));
        }
        if (
          url.includes("/api/providers/openai-codex/login") &&
          method === "POST"
        ) {
          return Promise.resolve(jsonResponse({ sessionId: "session-open" }));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[providers[1]]} onChanged={() => {}} />,
    );
    const codex = await accountRegion("OpenAI Codex");
    fireEvent.click(
      await within(codex).findByRole("button", { name: "再ログイン" }),
    );
    await waitFor(() => {
      expect(TestEventSource.instances).toHaveLength(1);
    });
    const source = TestEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");
    const authPayload = JSON.stringify({
      type: "notify",
      event: { type: "auth_url", url: "https://example.test/oauth", instructions: "open" },
    });
    await act(async () => {
      source.dispatchEvent(new MessageEvent("notify", { data: authPayload }));
      source.dispatchEvent(new MessageEvent("notify", { data: authPayload }));
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });

  it("disables account delete while that account is logging in", async () => {
    class TestEventSource extends EventTarget {
      static instances: TestEventSource[] = [];
      closed = false;
      constructor() {
        super();
        TestEventSource.instances.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", TestEventSource);
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [accounts[0]] }));
        }
        if (url.endsWith("/api/accounts/acc-1/auth-status")) {
          return Promise.resolve(jsonResponse({ providers: ["openai-codex"] }));
        }
        if (
          url.includes("/api/providers/openai-codex/login") &&
          method === "POST"
        ) {
          return Promise.resolve(jsonResponse({ sessionId: "session-del" }));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[providers[1]]} onChanged={() => {}} />,
    );
    const codex = await accountRegion("OpenAI Codex");
    const deleteButton = await within(codex).findByRole("button", { name: "削除" });
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(
      await within(codex).findByRole("button", { name: "再ログイン" }),
    );
    await waitFor(() => {
      expect(
        (within(codex).getByRole("button", { name: "削除" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });

  it("cancels login before sessionId and tears down a late POST session", async () => {
    let resolveLogin: ((value: Response) => void) | null = null;
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/accounts") && method === "GET") {
          return Promise.resolve(jsonResponse({ accounts: [accounts[0]] }));
        }
        if (url.endsWith("/api/accounts/acc-1/auth-status")) {
          return Promise.resolve(jsonResponse({ providers: ["openai-codex"] }));
        }
        if (
          url.includes("/api/providers/openai-codex/login") &&
          method === "POST" &&
          !url.includes("/answer")
        ) {
          return new Promise<Response>((resolve) => {
            resolveLogin = resolve;
          });
        }
        return Promise.resolve(jsonResponse({}));
      },
    );
    render(
      <ProviderAuthPanel providers={[providers[1]]} onChanged={() => {}} />,
    );
    const codex = await accountRegion("OpenAI Codex");
    fireEvent.click(
      await within(codex).findByRole("button", { name: "再ログイン" }),
    );
    await waitFor(() => {
      expect(screen.getByText("開始中…")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => {
      expect(screen.queryByText("開始中…")).toBeNull();
    });
    expect(resolveLogin).toBeTruthy();
    await act(async () => {
      resolveLogin?.(jsonResponse({ sessionId: "late-session" }));
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("sessionId=late-session") &&
            (init?.method ?? "GET").toUpperCase() === "DELETE",
        ),
      ).toBe(true);
    });
    expect(screen.queryByText("認証フロー待機中…")).toBeNull();
  });

  it("documents remote OAuth port-forward in the provider help", () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);
    fireEvent.click(screen.getByText("対応・設定方法"));
    expect(
      screen.getByText(/ssh -N -L 53692:127.0.0.1:53692 -L 1455:127.0.0.1:1455 user@host/),
    ).toBeTruthy();
    expect(screen.getByText(/デバイスコード/)).toBeTruthy();
  });
});
