// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthPanel } from "./ProviderAuthPanel";

const fetchMock = vi.fn();
let confirmSpy: { mockRestore: () => void } | null = null;

const providers = [
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
  {
    id: "llama-server",
    name: "llama-server",
    authenticated: true,
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
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/accounts")) {
      if (method === "GET") return Promise.resolve(jsonResponse({ accounts }));
      if (method === "POST") return Promise.resolve(jsonResponse({ account: accounts[0] }));
    }
    const statusMatch = url.match(/\/api\/accounts\/(acc-\d+)\/auth-status/);
    if (statusMatch) {
      const providerIds = statusMatch[1] === "acc-1" ? ["openai-codex"] : [];
      return Promise.resolve(jsonResponse({ providers: providerIds }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

async function accountRegion(name: string) {
  return screen.findByRole("region", { name: `${name} の追加アカウント` });
}

describe("ProviderAuthPanel provider-scoped accounts", () => {
  it("shows each account only inside its matching provider", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const codex = await accountRegion("OpenAI Codex");
    const anthropic = await accountRegion("Anthropic");
    expect(await within(codex).findByText("仕事用")).toBeTruthy();
    expect(within(codex).queryByText("個人用")).toBeNull();
    expect(await within(anthropic).findByText("個人用")).toBeTruthy();
    expect(within(anthropic).queryByText("仕事用")).toBeNull();
    expect(screen.queryByRole("region", { name: "llama-server の追加アカウント" })).toBeNull();
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
          String(input).endsWith("/api/providers/openai-codex") && init?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ accountRoutingMode: "integrated" });
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
    expect(screen.getAllByRole("button", { name: /^ログイン$/ })).toHaveLength(1);
    expect(within(anthropic).getByRole("button", { name: /^ログイン$/ })).toBeTruthy();
  });

  it("creates an account for the provider whose add action was used", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);

    const anthropic = await accountRegion("Anthropic");
    fireEvent.click(within(anthropic).getByRole("button", { name: "アカウントを追加" }));
    fireEvent.change(within(anthropic).getByLabelText("アカウント名"), {
      target: { value: "新規 Claude" },
    });
    fireEvent.click(within(anthropic).getByRole("button", { name: "追加" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/accounts") && (init?.method ?? "GET") === "POST",
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
    fireEvent.click(within(codex).getByRole("button", { name: "再ログイン" }));

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
          String(input).includes("/api/accounts/acc-1") && (init?.method ?? "") === "DELETE",
      );
      expect(del).toBeTruthy();
    });
  });
});
