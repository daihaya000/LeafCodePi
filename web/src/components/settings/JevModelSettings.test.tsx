// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS } from "@/lib/jev-model-settings";
import { JevModelSettings } from "./JevModelSettings";

const mocks = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.get, sendJson: mocks.send }));
const candidate = { providerId: "openrouter", providerName: "OpenRouter", accountId: "account-1", accountLabel: "Main", modelId: "typesafe/jev-1.13", name: "Jev 1.13", baseUrl: "https://openrouter.ai/api/v1", source: "catalog" };
const dto = { settings: { ...DEFAULT_JEV_MODEL_SETTINGS }, hasApiKey: { typesafe: true, compatible: false }, models: [candidate] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(dto);
  mocks.send.mockImplementation(async (_path: string, body: { settings: unknown }) => ({ ...dto, settings: body.settings }));
});
afterEach(cleanup);

async function ready() {
  render(<JevModelSettings />);
  await waitFor(() => expect(screen.queryByText("読み込み中…")).toBeNull());
}

function expand(provider: string) {
  fireEvent.click(screen.getByRole("button", { name: `${provider} のモデルを展開` }));
}

describe("JevModelSettings", () => {
  it("matches the provider/model catalog layout and keeps Composer separate", async () => {
    await ready();
    expect(screen.getByRole("heading", { name: "Jevモデル" })).toBeTruthy();
    expect(screen.getByText(/Composerには表示しません/)).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Jevプロバイダー・モデルを検索" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "TypeSafe のモデルを展開" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "OpenRouter のモデルを展開" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Jev互換API（手動） のモデルを展開" })).toBeTruthy();
    expect(screen.getAllByText("使用中")).toHaveLength(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("searches provider and model names and expands matching rows", async () => {
    await ready();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jev-1.13" } });
    expect(screen.getByRole("radio", { name: "OpenRouter · Main / Jev 1.13 を選択" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "TypeSafe のモデルを展開" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "not-found" } });
    expect(screen.getByText("検索条件に一致する項目はありません。")).toBeTruthy();
  });

  it("saves the manual endpoint only on explicit save and clears the key field", async () => {
    await ready();
    expand("Jev互換API（手動）");
    fireEvent.click(screen.getByRole("radio", { name: "Jev互換API（手動） / jev-latest を選択" }));
    fireEvent.change(screen.getByLabelText("モデルID"), { target: { value: "my-judge" } });
    fireEvent.change(screen.getByLabelText(/APIベースURL/), { target: { value: "http://localhost:8080/v1" } });
    fireEvent.change(screen.getByLabelText(/Jev APIキー/), { target: { value: "test-only-key" } });
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Jevモデルを保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", {
      settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "compatible", compatibleBaseUrl: "http://localhost:8080/v1", compatibleModel: "my-judge" },
      apiKey: "test-only-key",
    }, "PUT"));
    await waitFor(() => expect((screen.getByLabelText(/Jev APIキー/) as HTMLInputElement).value).toBe(""));
    expect(screen.getByText(/次のJev判定から反映/)).toBeTruthy();
  });

  it("keeps the manual draft but does not transfer its key when selecting TypeSafe", async () => {
    await ready();
    expand("Jev互換API（手動）");
    fireEvent.click(screen.getByRole("radio", { name: /Jev互換API（手動）.*選択/ }));
    fireEvent.change(screen.getByLabelText(/APIベースURL/), { target: { value: "http://localhost:8080/v1" } });
    fireEvent.change(screen.getByLabelText(/Jev APIキー/), { target: { value: "test-only-key" } });
    expand("TypeSafe");
    fireEvent.click(screen.getByRole("radio", { name: "TypeSafe / Jev を選択" }));
    expect((screen.getAllByLabelText(/Jev APIキー/)[0] as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Jevモデルを保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", {
      settings: { ...DEFAULT_JEV_MODEL_SETTINGS, compatibleBaseUrl: "http://localhost:8080/v1" },
    }, "PUT"));
  });

  it("selects an account model without asking for another key", async () => {
    await ready();
    expand("OpenRouter");
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter · Main / Jev 1.13 を選択" }));
    expect(screen.getByText(/既存アカウント認証を使用/)).toBeTruthy();
    expect(screen.queryByLabelText(/Jev APIキー/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Jevモデルを保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", {
      settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" } },
    }, "PUT"));
  });

  it("refreshes provider candidates without overwriting a draft selection", async () => {
    const documented = { providerId: "commandcode", providerName: "Command Code", modelId: "typesafe/jev", name: "Jev", baseUrl: "https://api.commandcode.ai/provider/v1", source: "documented" };
    mocks.get.mockResolvedValueOnce(dto).mockResolvedValueOnce({ ...dto, models: [candidate, documented] });
    await ready();
    expand("Jev互換API（手動）");
    fireEvent.click(screen.getByRole("radio", { name: /Jev互換API（手動）.*選択/ }));
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Command Code のモデルを展開" })).toBeTruthy());
    expect((screen.getByRole("radio", { name: /Jev互換API（手動）.*選択/ }) as HTMLInputElement).checked).toBe(true);
    expect(mocks.get).toHaveBeenCalledWith("/api/jev-model", { refresh: "1" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not save an unavailable selected model until a valid one is chosen", async () => {
    mocks.get.mockResolvedValue({ ...dto, models: [], settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" } } });
    await ready();
    expect(screen.getByRole("alert").textContent).toContain("未検出");
    expect((screen.getByRole("button", { name: "Jevモデルを保存" }) as HTMLButtonElement).disabled).toBe(true);
    expand("TypeSafe");
    fireEvent.click(screen.getByRole("radio", { name: "TypeSafe / Jev を選択" }));
    expect((screen.getByRole("button", { name: "Jevモデルを保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends null only when deleting the selected credential", async () => {
    await ready();
    expand("TypeSafe");
    fireEvent.click(screen.getByLabelText("選択した接続先の保存済みAPIキーを削除"));
    fireEvent.click(screen.getByRole("button", { name: "Jevモデルを保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", { settings: DEFAULT_JEV_MODEL_SETTINGS, apiKey: null }, "PUT"));
  });

  it("displays save failures without claiming the selection was applied", async () => {
    mocks.send.mockRejectedValue(new Error("保存失敗"));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Jevモデルを保存" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("保存失敗"));
    expect(screen.queryByText(/次のJev判定から反映/)).toBeNull();
  });
});
