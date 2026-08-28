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

function mockAccountsApi() {
  fetchMock.mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/accounts")) {
        if (method === "GET")
          return Promise.resolve(jsonResponse({ accounts }));
        if (method === "POST")
          return Promise.resolve(jsonResponse({ account: accounts[0] }));
      }
      const statusMatch = url.match(/\/api\/accounts\/(acc-\d+)\/auth-status/);
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
  it("skips account loading when no account-managed provider is available", () => {
    render(<ProviderAuthPanel providers={providers.slice(0, 1)} onChanged={() => {}} />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows each account only inside its matching provider", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const codex = await accountRegion("OpenAI Codex");
    const anthropic = await accountRegion("Anthropic");
    expect(await within(codex).findByText("仕事用")).toBeTruthy();
    expect(within(codex).queryByText("個人用")).toBeNull();
    expect(await within(anthropic).findByText("個人用")).toBeTruthy();
    expect(within(anthropic).queryByText("仕事用")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "llama-server の追加アカウント" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "アカウント" })).toBeNull();
  });

  it("changes the routing mode from the provider section", async () => {
    mockAccountsApi();
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
    expect(screen.getAllByText("アカウントで管理")).toHaveLength(2);
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
    expect(screen.getByText("アカウントで管理")).toBeTruthy();
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

  it("shows registered providers first without an other-providers section", () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const heading = screen.getByRole("heading", { name: "プロバイダー" });
    const providerList = heading.parentElement?.querySelector("ul");
    expect(providerList).toBeTruthy();
    expect(providerList?.className).not.toContain("overflow-y-auto");
    expect(providerList?.className).not.toContain("max-h-72");
    expect(
      screen.queryByRole("heading", { name: "その他のプロバイダー" }),
    ).toBeNull();
    const registered = screen.getByText("OpenAI Codex");
    const unregistered = screen.getByText("llama-server", {
      selector: "span.text-sm.font-medium",
    });
    expect(
      Boolean(
        registered.compareDocumentPosition(unregistered) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
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
