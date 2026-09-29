// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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

    expect(screen.getByRole("button", { name: "OpenAI Codex を上へ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "OpenAI Codex を下へ" })).toBeTruthy();
    expect(screen.queryByText("アカウント: 仕事用")).toBeNull();
    expect(screen.queryByText("アカウント: 個人用")).toBeNull();
  });

  it("filters model rows by name without regard to case", async () => {
    render(<ProviderModelsPanel />);
    const search = await screen.findByRole("searchbox", {
      name: "プロバイダー・モデルを検索",
    });
    fireEvent.change(search, { target: { value: "gPt-4" } });

    expect(
      await screen.findByRole("switch", {
        name: "OpenAI Codex · 仕事用 の GPT-4 を無効化",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("switch", {
        name: "OpenAI Codex · 仕事用 の GPT-5 を無効化",
      }),
    ).toBeNull();

    fireEvent.change(search, { target: { value: "openai" } });
    expect(
      await screen.findByRole("button", {
        name: "OpenAI Codex · 個人用 のモデルを展開",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Ollama Cloud のモデルを展開" }),
    ).toBeNull();

    fireEvent.change(search, { target: { value: "no-such-model" } });
    expect(await screen.findByText("検索条件に一致する項目はありません。"))
      .toBeTruthy();
  });

  it("shows only enabled providers and models, also when searching", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse({
        providers: [
          {
            id: "active",
            name: "Active",
            enabled: true,
            models: [
              { id: "ready", name: "Ready", enabled: true },
              { id: "hidden", name: "Hidden", enabled: false },
            ],
          },
          {
            id: "inactive",
            name: "Inactive",
            enabled: false,
            models: [{ id: "ready", name: "Ready", enabled: true }],
          },
        ],
      })),
    );
    render(<ProviderModelsPanel />);
    const filter = await screen.findByRole("button", { name: "有効化のみ" });
    const search = screen.getByRole("searchbox", { name: "プロバイダー・モデルを検索" });
    expect(filter.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("switch", { name: "Inactive を有効化" })).toBeTruthy();

    fireEvent.click(filter);
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("switch", { name: "Inactive を有効化" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Active のモデルを展開" }));
    expect(screen.getByRole("switch", { name: "Active の Ready を無効化" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Active の Hidden を有効化" })).toBeNull();

    fireEvent.change(search, { target: { value: "hidden" } });
    expect(screen.queryByRole("switch", { name: "Active の Hidden を有効化" })).toBeNull();
    expect(screen.getByText("検索条件に一致する項目はありません。")).toBeTruthy();
    fireEvent.change(search, { target: { value: "ready" } });
    expect(screen.getByRole("switch", { name: "Active の Ready を無効化" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("switch", { name: "Active の Ready を無効化" }));
    expect(screen.queryByRole("switch", { name: "Active の Ready を無効化" })).toBeNull();
    await waitFor(() => {
      expect((screen.getByRole("switch", { name: "Active を無効化" }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("switch", { name: "Active を無効化" }));
    expect(screen.getByText("有効なプロバイダーはありません。")).toBeTruthy();
    fireEvent.click(filter);
    expect(filter.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("switch", { name: "Inactive を有効化" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Active を有効化" })).toBeTruthy();
  });

  it("keeps enabled providers with no enabled models visible", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse({
        providers: [{
          id: "empty",
          name: "Empty",
          enabled: true,
          models: [{ id: "off", name: "Off", enabled: false }],
        }],
      })),
    );
    render(<ProviderModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "有効化のみ" }));
    expect(screen.getByRole("switch", { name: "Empty を無効化" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Empty のモデルを展開" }));
    expect(screen.queryByRole("switch", { name: "Empty の Off を有効化" })).toBeNull();
  });

  it("hides context token controls from model rows", async () => {
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });
    fireEvent.click(screen.getByRole("button", { name: "Ollama Cloud のモデルを展開" }));

    expect(screen.queryByText("tokens", { exact: true })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Llama 3 のコンテキストサイズ" })).toBeNull();
  });

  it("shows the nearest Codex reset credit expiry", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const soon = new Date(Date.now() + 2 * dayMs).toISOString();
    const later = new Date(Date.now() + 10 * dayMs).toISOString();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/provider-models" && method === "GET") {
        return Promise.resolve(jsonResponse({ providers }));
      }
      if (url.pathname === "/api/codexbar/reset-credits" && method === "GET") {
        return Promise.resolve(
          jsonResponse({
            credits:
              url.searchParams.get("accountId") === "acc-1"
                ? [{ expiresAt: later }, { expiresAt: soon }]
                : [],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ProviderModelsPanel />);

    expect(await screen.findByText("リセット権: 最短期限まであと2日")).toBeTruthy();
  });

  it("shows the nearest Anthropic reset credit expiry for its account", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const soon = new Date(Date.now() + 3 * dayMs).toISOString();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/provider-models" && method === "GET") {
        return Promise.resolve(
          jsonResponse({
            providers: [
              {
                id: "anthropic",
                name: "Anthropic",
                accountId: "anthropic-1",
                accountLabel: "daichi@example.com",
                enabled: true,
                models: [{ id: "claude", name: "Claude", enabled: true }],
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/codexbar/reset-credits" && method === "GET") {
        const matchesAccount =
          url.searchParams.get("provider") === "anthropic" &&
          url.searchParams.get("accountId") === "anthropic-1";
        return Promise.resolve(
          jsonResponse({ credits: matchesAccount ? [{ expiresAt: soon }] : [] }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ProviderModelsPanel />);

    expect(await screen.findByText("リセット権: 最短期限まであと3日")).toBeTruthy();
    const resetCall = fetchMock.mock.calls.find(([input]) =>
      new URL(String(input), "http://localhost").pathname ===
      "/api/codexbar/reset-credits",
    );
    expect(resetCall).toBeTruthy();
    const resetUrl = new URL(String(resetCall?.[0]), "http://localhost");
    expect(resetUrl.searchParams.get("provider")).toBe("anthropic");
    expect(resetUrl.searchParams.get("accountId")).toBe("anthropic-1");
  });

  it("shows the nearest reset credit expiry across integrated Codex accounts", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const soon = new Date(Date.now() + dayMs).toISOString();
    const later = new Date(Date.now() + 7 * dayMs).toISOString();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/provider-models" && method === "GET") {
        return Promise.resolve(
          jsonResponse({
            providers: [
              {
                id: "openai-codex",
                name: "OpenAI Codex",
                enabled: true,
                accountIds: ["acc-1", "acc-2"],
                models: [{ id: "gpt-5", name: "GPT-5", enabled: true }],
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/codexbar/reset-credits" && method === "GET") {
        return Promise.resolve(
          jsonResponse({
            credits:
              url.searchParams.get("accountId") === "acc-2"
                ? [{ expiresAt: soon }]
                : [{ expiresAt: later }],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ProviderModelsPanel />);

    expect(await screen.findByText("リセット権: 最短期限まであと1日")).toBeTruthy();
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

  it("saves the selected model's default effort for its account", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse({
          providers: [
            {
              id: "openai-codex",
              name: "OpenAI Codex",
              accountId: "acc-1",
              accountLabel: "仕事用",
              enabled: true,
              models: [
                {
                  id: "gpt-5",
                  name: "GPT-5",
                  enabled: true,
                  thinkingLevels: ["low", "medium", "high"],
                  defaultThinkingLevel: "medium",
                },
              ],
            },
          ],
        }),
      ),
    );
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });
    fireEvent.click(
      screen.getByRole("button", { name: "OpenAI Codex · 仕事用 のモデルを展開" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "GPT-5 の既定effort" }));
    fireEvent.click(await screen.findByRole("option", { name: "high" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes("/api/provider-models/openai-codex%3A%3Agpt-5") &&
          init?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        defaultThinkingLevel: "high",
        accountId: "acc-1",
      });
    });
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

  it("refreshes Jev provider state only after a provider toggle is saved", async () => {
    const onProviderCatalogChange = vi.fn();
    render(<ProviderModelsPanel onProviderCatalogChange={onProviderCatalogChange} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Ollama Cloud を無効化" }));
    await waitFor(() => expect(onProviderCatalogChange).toHaveBeenCalledTimes(1));
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

  it("moves account rows in the same list as shared providers with buttons", async () => {
    const onProviderCatalogChange = vi.fn();
    render(<ProviderModelsPanel onProviderCatalogChange={onProviderCatalogChange} />);
    await screen.findByRole("heading", { name: "モデル" });

    expect(
      (screen.getByRole("button", { name: "Ollama Cloud を上へ" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "OpenAI Codex · 仕事用 を上へ" }),
    );

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
    expect(screen.getByRole("status").textContent).toContain(
      "OpenAI Codex · 仕事用を1番目へ移動しました",
    );
    await waitFor(() => expect(onProviderCatalogChange).toHaveBeenCalledTimes(1));
  });

  it("saves model order under the selected account with buttons", async () => {
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "モデル" });
    fireEvent.click(
      screen.getByRole("button", { name: "OpenAI Codex · 仕事用 のモデルを展開" }),
    );

    expect(
      (screen.getByRole("button", {
        name: "OpenAI Codex · 仕事用 の GPT-4 を下へ",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "OpenAI Codex · 仕事用 の GPT-5 を下へ" }),
    );

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
    expect(screen.getByRole("status").textContent).toContain(
      "OpenAI Codex · 仕事用 の GPT-5を2番目へ移動しました",
    );
  });

  it("blocks long-press selection only in reorder rows and leaves scrolling enabled", async () => {
    render(<ProviderModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "OpenAI Codex · 仕事用 のモデルを展開" }));
    const providerRow = screen.getByRole("button", {
      name: "OpenAI Codex · 仕事用 を上へ",
    }).closest<HTMLElement>("[data-provider-row]")!;
    const list = providerRow.parentElement!;
    expect(list.classList.contains("select-none")).toBe(true);
    // happy-dom stores React's vendor-prefixed assignments as JS properties.
    const style = list.style as unknown as Record<string, string>;
    expect(style.WebkitUserSelect).toBe("none");
    expect(style.WebkitTouchCallout).toBe("none");
    expect(list.classList.contains("touch-none")).toBe(false);
    expect(list.style.touchAction).not.toBe("none");
    for (const handle of list.querySelectorAll<HTMLElement>("[data-reorder-provider], [data-reorder-model]")) {
      expect(handle.classList.contains("touch-none")).toBe(true);
    }
    expect(list.contains(screen.getByRole("searchbox"))).toBe(false);

    const down = new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerId: 12, pointerType: "touch",
    });
    fireEvent(screen.getByText("GPT-4"), down);
    expect(down.defaultPrevented).toBe(false);
  });

  it("keeps mouse drag-and-drop reordering alongside touch dragging", async () => {
    render(<ProviderModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "OpenAI Codex · 仕事用 のモデルを展開" }));
    const source = screen.getByRole("button", {
      name: "OpenAI Codex · 仕事用 の GPT-5 を下へ",
    }).closest("[data-model-row]")!;
    const target = screen.getByRole("button", {
      name: "OpenAI Codex · 仕事用 の GPT-4 を下へ",
    }).closest("[data-model-row]")!;
    fireEvent.dragStart(source, { dataTransfer: { effectAllowed: "move" } });
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([input, init]) =>
        String(input).endsWith("/api/provider-models/order") && init?.method === "PATCH",
      );
      expect(JSON.parse(String(patch?.[1]?.body)).accountModelOrder["acc-1"]["openai-codex"])
        .toEqual(["gpt-4", "gpt-5"]);
    });
  });

  it("touch drag moves models and provider rows and saves each order", async () => {
    render(<ProviderModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "OpenAI Codex · 仕事用 のモデルを展開" }));
    let hitTarget: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => hitTarget),
    });
    try {
      const modelHandle = screen.getByRole("button", {
        name: "OpenAI Codex · 仕事用 の GPT-5 を下へ",
      }).closest("[data-model-row]")!.querySelector<HTMLElement>("[data-reorder-model]")!;
      Object.defineProperty(modelHandle, "setPointerCapture", { value: vi.fn() });
      hitTarget = screen.getByRole("button", {
        name: "OpenAI Codex · 仕事用 の GPT-4 を下へ",
      }).closest("[data-model-row]");
      fireEvent.pointerDown(modelHandle, { pointerId: 7, pointerType: "touch" });
      fireEvent.pointerMove(modelHandle, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 200 });
      expect(hitTarget?.className).toContain("ring-accent");
      fireEvent.pointerUp(modelHandle, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 200 });
      await waitFor(() => {
        const patches = fetchMock.mock.calls.filter(([input, init]) =>
          String(input).endsWith("/api/provider-models/order") && init?.method === "PATCH",
        );
        expect(patches).toHaveLength(1);
        expect(JSON.parse(String(patches[0]?.[1]?.body)).accountModelOrder["acc-1"]["openai-codex"])
          .toEqual(["gpt-4", "gpt-5"]);
      });

      const providerHandle = screen.getByRole("button", {
        name: "OpenAI Codex · 個人用 を上へ",
      }).closest("[data-provider-row]")!.querySelector<HTMLElement>("[data-reorder-provider]")!;
      Object.defineProperty(providerHandle, "setPointerCapture", { value: vi.fn() });
      hitTarget = screen.getByRole("button", { name: "Ollama Cloud を上へ" }).closest("[data-provider-row]");
      fireEvent.pointerDown(providerHandle, { pointerId: 8, pointerType: "touch" });
      fireEvent.pointerUp(providerHandle, { pointerId: 8, pointerType: "touch", clientX: 100, clientY: 200 });
      await waitFor(() => {
        const patches = fetchMock.mock.calls.filter(([input, init]) =>
          String(input).endsWith("/api/provider-models/order") && init?.method === "PATCH",
        );
        expect(patches).toHaveLength(2);
        expect(JSON.parse(String(patches[1]?.[1]?.body)).providerOrder)
          .toEqual(["acc-2::openai-codex", "ollama-cloud", "acc-1::openai-codex"]);
      });
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("ignores touch model drops on another provider and cancelled drags", async () => {
    render(<ProviderModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "OpenAI Codex · 仕事用 のモデルを展開" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenAI Codex · 個人用 のモデルを展開" }));
    const handle = screen.getByRole("button", {
      name: "OpenAI Codex · 仕事用 の GPT-5 を下へ",
    }).closest("[data-model-row]")!.querySelector<HTMLElement>("[data-reorder-model]")!;
    Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => screen.getByRole("button", {
        name: "OpenAI Codex · 個人用 の GPT-5 を上へ",
      })),
    });
    try {
      fireEvent.pointerDown(handle, { pointerId: 9, pointerType: "touch" });
      fireEvent.pointerUp(handle, { pointerId: 9, pointerType: "touch", clientX: 100, clientY: 200 });
      fireEvent.pointerDown(handle, { pointerId: 10, pointerType: "touch" });
      fireEvent.pointerCancel(handle, { pointerId: 10, pointerType: "touch" });
      expect(fetchMock.mock.calls.filter(([input, init]) =>
        String(input).endsWith("/api/provider-models/order") && init?.method === "PATCH",
      )).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("StrictModeでも並び替えボタンの1回クリックでPATCHは1回だけ送信される", async () => {
    render(
      <StrictMode>
        <ProviderModelsPanel />
      </StrictMode>,
    );
    await screen.findByRole("heading", { name: "モデル" });

    fireEvent.click(
      screen.getByRole("button", { name: "OpenAI Codex · 仕事用 を上へ" }),
    );

    await waitFor(() => {
      const orderPatches = fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith("/api/provider-models/order") && init?.method === "PATCH",
      );
      expect(orderPatches).toHaveLength(1);
    });
  });
});
