// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderModelsPanel } from "./ProviderModelsPanel";

const fetchMock = vi.fn();

const providers = [
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
  it("updates only the selected account model", async () => {
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "アカウント別モデル" });
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

  it("saves model order under the selected account", async () => {
    render(<ProviderModelsPanel />);
    await screen.findByRole("heading", { name: "アカウント別モデル" });
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
