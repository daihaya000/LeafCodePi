// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderModelsPanel } from "./ProviderModelsPanel";

const fetchMock = vi.fn();

const providers = [
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    enabled: true,
    models: [{ id: "llama-3", name: "Llama 3", enabled: true }],
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    accountId: "acc-1",
    accountLabel: "仕事用",
    enabled: true,
    models: [
      { id: "gpt-5", name: "GPT-5", enabled: true },
      { id: "gpt-4", name: "GPT-4", enabled: true },
    ],
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    accountId: "acc-2",
    accountLabel: "個人用",
    enabled: true,
    models: [{ id: "gpt-5", name: "GPT-5", enabled: true }],
  },
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/provider-models") && method === "GET") {
      return Promise.resolve(jsonResponse({ providers }));
    }
    if (url.includes("/api/provider-models/") && method === "PATCH") {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (url.endsWith("/api/provider-models/order") && method === "PATCH") {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ProviderModelsPanel account model settings", () => {
  it("renders integrated providers without account-specific rows", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse({
          providers: [
            {
              id: "openai-codex",
              name: "OpenAI Codex",
              enabled: true,
              models: [{ id: "gpt-5", name: "GPT-5", enabled: true }],
            },
          ],
        }),
      ),
    );
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });

    expect(screen.getByLabelText("OpenAI Codex をドラッグして並び替え")).toBeTruthy();
    expect(screen.queryByText("アカウント: 仕事用")).toBeNull();
    expect(screen.queryByText("アカウント: 個人用")).toBeNull();
  });

  it("refreshes the catalog without losing expanded state", async () => {
    const { rerender } = render(<ProviderModelsPanel refreshToken={0} />);
    await screen.findByRole("button", {
      name: "OpenAI Codex · 仕事用 のモデルを展開",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "OpenAI Codex · 仕事用 のモデルを展開",
      }),
    );
    expect(
      screen.getByRole("switch", {
        name: "OpenAI Codex · 仕事用 の GPT-5 を無効化",
      }),
    ).toBeTruthy();

    rerender(<ProviderModelsPanel refreshToken={1} />);

    await waitFor(() => {
      const catalogCalls = fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith("/api/provider-models") &&
          (init?.method ?? "GET").toUpperCase() === "GET",
      );
      expect(catalogCalls).toHaveLength(2);
    });
    expect(
      screen.getByRole("switch", {
        name: "OpenAI Codex · 仕事用 の GPT-5 を無効化",
      }),
    ).toBeTruthy();
  });

  it("updates only the selected account model", async () => {
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });
    expect(screen.queryByRole("heading", { name: "アカウント別モデル" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "OpenAI Codex · 仕事用 のモデルを展開" }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "OpenAI Codex · 仕事用 の GPT-5 を無効化" }),
    );

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes("/api/provider-models/openai-codex%3A%3Agpt-5") &&
          init?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        enabled: false,
        accountId: "acc-1",
      });
    });
  });

  it("re-enables a switch without waiting for catalog refresh", async () => {
    let getCount = 0;
    const pendingRefresh = new Promise<Response>(() => {});
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/provider-models") && method === "GET") {
        getCount += 1;
        return getCount === 1
          ? Promise.resolve(jsonResponse({ providers }))
          : pendingRefresh;
      }
      if (url.endsWith("/api/provider-models/ollama-cloud") && method === "PATCH") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });
    fireEvent.click(screen.getByRole("switch", { name: "Ollama Cloud を無効化" }));

    await waitFor(() => {
      const toggle = screen.getByRole("switch", { name: "Ollama Cloud を有効化" });
      expect(toggle).toBeTruthy();
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
    });
    expect(getCount).toBe(1);
  });

  it("sends all child models as disabled when enabling a provider", async () => {
    let provider = {
      id: "ollama-cloud",
      name: "Ollama Cloud",
      enabled: false,
      models: [
        { id: "llama-3", name: "Llama 3", enabled: false },
        { id: "llama-2", name: "Llama 2", enabled: false },
      ],
    };
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/provider-models") && method === "GET") {
        return Promise.resolve(jsonResponse({ providers: [provider] }));
      }
      if (url.endsWith("/api/provider-models/ollama-cloud") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        provider = {
          ...provider,
          enabled: body.enabled,
          models: provider.models.map((model) => ({ ...model, enabled: false })),
        };
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });
    fireEvent.click(screen.getByRole("button", { name: "Ollama Cloud のモデルを展開" }));
    fireEvent.click(screen.getByRole("switch", { name: "Ollama Cloud を有効化" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/provider-models/ollama-cloud") &&
          init?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        enabled: true,
        modelIds: ["llama-3", "llama-2"],
      });
    });
  });

  it("moves account rows in the same list as shared providers", async () => {
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });

    const source = screen
      .getByLabelText("OpenAI Codex · 仕事用 をドラッグして並び替え")
      .closest("li");
    const target = screen
      .getByLabelText("Ollama Cloud をドラッグして並び替え")
      .closest("li");
    expect(source).toBeTruthy();
    expect(target).toBeTruthy();
    const dataTransfer = { effectAllowed: "", setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(source!, { dataTransfer });
    fireEvent.dragOver(target!, { dataTransfer });
    fireEvent.drop(target!, { dataTransfer });

    await waitFor(() => {
      const orderPatch = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/provider-models/order") && init?.method === "PATCH",
      );
      expect(orderPatch).toBeTruthy();
      expect(JSON.parse(String(orderPatch?.[1]?.body))).toMatchObject({
        providerOrder: ["acc-1::openai-codex", "ollama-cloud", "acc-2::openai-codex"],
      });
    });
  });

  it("saves model order under the selected account", async () => {
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });
    fireEvent.click(
      screen.getByRole("button", { name: "OpenAI Codex · 仕事用 のモデルを展開" }),
    );

    const source = screen
      .getByLabelText("OpenAI Codex · 仕事用 の GPT-5 をドラッグして並び替え")
      .closest("li");
    const target = screen
      .getByLabelText("OpenAI Codex · 仕事用 の GPT-4 をドラッグして並び替え")
      .closest("li");
    expect(source).toBeTruthy();
    expect(target).toBeTruthy();
    const dataTransfer = { effectAllowed: "", setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(source!, { dataTransfer });
    fireEvent.dragOver(target!, { dataTransfer });
    fireEvent.drop(target!, { dataTransfer });

    await waitFor(() => {
      const orderPatch = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/provider-models/order") && init?.method === "PATCH",
      );
      expect(orderPatch).toBeTruthy();
      expect(JSON.parse(String(orderPatch?.[1]?.body))).toMatchObject({
        accountModelOrder: {
          "acc-1": { "openai-codex": ["gpt-4", "gpt-5"] },
        },
      });
    });
  });
});
