// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS } from "@/lib/jev-model-settings";
import { JevModelSettings } from "./JevModelSettings";

const mocks = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.get, sendJson: mocks.send }));
const typesafe = { providerId: "typesafe", providerName: "TypeSafe", modelId: "jev-latest", name: "Jev", baseUrl: "https://api.typesafe.ai/v1", source: "documented", providerEnabled: true };
const candidate = { providerId: "openrouter", providerName: "OpenRouter", accountId: "account-1", accountLabel: "Main", modelId: "typesafe/jev-1.13", name: "Jev 1.13", baseUrl: "https://openrouter.ai/api/v1", source: "catalog", providerEnabled: true };
const dto = { settings: { ...DEFAULT_JEV_MODEL_SETTINGS }, hasApiKey: { typesafe: true, compatible: false }, models: [typesafe, candidate] };

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
  it("uses the same provider cards without a second connection/credential form", async () => {
    await ready();
    expect(screen.getByRole("heading", { name: "Jevモデル" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "プロバイダー接続" }).getAttribute("href")).toBe("#models-providers");
    expect(screen.getByRole("searchbox", { name: "Jevプロバイダー・モデルを検索" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "TypeSafe のモデルを展開" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "OpenRouter のモデルを展開" })).toBeTruthy();
    expect(screen.queryByText("Jev互換API（手動）")).toBeNull();
    expand("TypeSafe");
    expect(screen.getByRole("radio", { name: "TypeSafe / Jev を選択" })).toBeTruthy();
    expect(screen.queryByLabelText(/APIキー|APIベースURL|モデルID/)).toBeNull();
    expect(screen.getAllByText("有効")).toHaveLength(2);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("searches provider/model names and expands matches", async () => {
    await ready();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jev-1.13" } });
    expect(screen.getByRole("radio", { name: "OpenRouter · Main / Jev 1.13 を選択" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "TypeSafe のモデルを展開" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "not-found" } });
    expect(screen.getByText("検索条件に一致する項目はありません。")).toBeTruthy();
  });

  it("saves only an existing provider reference after explicit selection", async () => {
    await ready();
    expand("OpenRouter");
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter · Main / Jev 1.13 を選択" }));
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Jevモデルを保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", {
      settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" } },
    }, "PUT"));
    expect(screen.getByText(/次のJev判定から反映/)).toBeTruthy();
  });

  it("reflects model-side disabled providers without changing them here", async () => {
    mocks.get.mockResolvedValue({ ...dto, models: [typesafe, { ...candidate, providerEnabled: false }] });
    await ready();
    expand("OpenRouter");
    expect(screen.getByText("無効")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "OpenRouter · Main / Jev 1.13 を選択" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("refreshes candidates without overwriting an unsaved choice", async () => {
    const documented = { providerId: "commandcode", providerName: "Command Code", modelId: "typesafe/jev", name: "Jev", baseUrl: "https://api.commandcode.ai/provider/v1", source: "documented" };
    mocks.get.mockResolvedValueOnce(dto).mockResolvedValueOnce({ ...dto, models: [typesafe, candidate, documented] });
    await ready();
    expand("OpenRouter");
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter · Main / Jev 1.13 を選択" }));
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Command Code のモデルを展開" })).toBeTruthy());
    expect((screen.getByRole("radio", { name: "OpenRouter · Main / Jev 1.13 を選択" }) as HTMLInputElement).checked).toBe(true);
    expect(mocks.get).toHaveBeenCalledWith("/api/jev-model", { refresh: "1" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("blocks saving a disabled or missing selected provider and allows recovery", async () => {
    mocks.get.mockResolvedValue({ ...dto, settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" } }, models: [typesafe, { ...candidate, providerEnabled: false }] });
    await ready();
    expect(screen.getByRole("alert").textContent).toContain("無効");
    expect((screen.getByRole("button", { name: "Jevモデルを保存" }) as HTMLButtonElement).disabled).toBe(true);
    expand("TypeSafe");
    fireEvent.click(screen.getByRole("radio", { name: "TypeSafe / Jev を選択" }));
    expect((screen.getByRole("button", { name: "Jevモデルを保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("preserves an old manual endpoint without offering a second provider form", async () => {
    mocks.get.mockResolvedValue({ ...dto, settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "compatible", compatibleBaseUrl: "http://localhost:8080/v1" } });
    await ready();
    expect(screen.getByText(/従来の手動接続先を使用中/)).toBeTruthy();
    expect(screen.queryByLabelText(/APIベースURL|Jev APIキー/)).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("keeps timeout as Jev-only advanced setting and reports save failure", async () => {
    mocks.send.mockRejectedValue(new Error("保存失敗"));
    await ready();
    fireEvent.click(screen.getByText("Jev判定の詳細設定"));
    fireEvent.change(screen.getByLabelText("タイムアウト（ミリ秒）"), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "Jevモデルを保存" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("保存失敗"));
    expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", { settings: { ...DEFAULT_JEV_MODEL_SETTINGS, timeoutMs: 4000 } }, "PUT");
  });
});
