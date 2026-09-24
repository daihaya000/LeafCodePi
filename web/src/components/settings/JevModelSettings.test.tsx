// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(mocks.get).toHaveBeenCalledWith("/api/jev-model", undefined, undefined);
    expect(screen.getByRole("link", { name: "プロバイダー接続" }).getAttribute("href")).toBe("#models-providers");
    expect(screen.getByRole("searchbox", { name: "Jevプロバイダー・モデルを検索" })).toBeTruthy();
    const expandButton = screen.getByRole("button", { name: "TypeSafe のモデルを展開" });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    expect(expandButton.parentElement?.parentElement?.className).toContain("px-4 py-3");
    expect(screen.getByRole("button", { name: "OpenRouter のモデルを展開" })).toBeTruthy();
    expect(screen.queryByText("Jev互換API（手動）")).toBeNull();
    expand("TypeSafe");
    const modelSwitch = screen.getByRole("switch", { name: "TypeSafe / Jev を無効化" });
    expect(modelSwitch.getAttribute("aria-checked")).toBe("true");
    expect(modelSwitch.firstElementChild?.className).toContain("bg-success");
    expect(modelSwitch.closest("li")?.className).toContain("px-4 py-3");
    expect(screen.queryByLabelText(/APIキー|APIベースURL|モデルID/)).toBeNull();
    expect(screen.getAllByText("有効")).toHaveLength(3);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("searches provider/model names and expands matches", async () => {
    await ready();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jev-1.13" } });
    expect(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を有効化" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "TypeSafe のモデルを展開" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "not-found" } });
    expect(screen.getByText("検索条件に一致する項目はありません。")).toBeTruthy();
  });

  it("automatically saves an explicit model selection without a save button", async () => {
    await ready();
    expect(screen.queryByRole("button", { name: "Jevモデルを保存" })).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expand("OpenRouter");
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を有効化" }));
    expect(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を無効化" }).firstElementChild?.className).toContain("bg-success");
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", {
      settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "typesafe", modelId: "jev-latest" }, enabledModels: [{ providerId: "typesafe", modelId: "jev-latest" }, { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" }] },
    }, "PUT"));
    await waitFor(() => expect(screen.getByText(/次のJev判定から反映/)).toBeTruthy());
  });

  it("combines rapid model changes into one persisted selection", async () => {
    await ready();
    expand("OpenRouter");
    expand("TypeSafe");
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を有効化" }));
    fireEvent.click(screen.getByRole("switch", { name: "TypeSafe / Jev を無効化" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", {
      settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" }, enabledModels: [{ providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" }] },
    }, "PUT"));
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("serializes a second selection while the first save is in flight", async () => {
    let releaseFirst!: (value: typeof dto) => void;
    const first = new Promise<typeof dto>((resolve) => { releaseFirst = resolve; });
    mocks.send.mockImplementationOnce(() => first);
    await ready();
    expand("OpenRouter");
    expand("TypeSafe");
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を有効化" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("switch", { name: "TypeSafe / Jev を無効化" }));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    await act(async () => { releaseFirst({ ...dto, settings: mocks.send.mock.calls[0][1].settings }); });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1][1].settings.enabledModels).toEqual([{ providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" }]);
    await waitFor(() => expect(screen.getByRole("switch", { name: "TypeSafe / Jev を有効化" })).toBeTruthy());
  });

  it("flushes a pending automatic save when leaving the settings page", async () => {
    const { unmount } = render(<JevModelSettings />);
    await waitFor(() => expect(screen.queryByText("読み込み中…")).toBeNull());
    expand("OpenRouter");
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を有効化" }));
    unmount();
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  });

  it("shows shared provider switches and keeps disabled models unselectable", async () => {
    mocks.get.mockResolvedValue({ ...dto, models: [typesafe, { ...candidate, providerEnabled: false }] });
    await ready();
    expand("OpenRouter");
    expect(screen.getAllByText("無効")).toHaveLength(2);
    expect((screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を有効化" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("switch", { name: "OpenRouter · Main を有効化" }).getAttribute("aria-checked")).toBe("false");
  });

  it("enables a provider through the shared catalog without changing the Jev selection", async () => {
    let current = { ...dto, models: [typesafe, { ...candidate, providerEnabled: false }] };
    mocks.get.mockImplementation(async (path: string) => path === "/api/provider-models"
      ? { providers: [{ id: "typesafe", models: [{ id: "regular" }] }, { id: "openrouter", accountId: "account-1", models: [{ id: "chat-model" }] }] }
      : current);
    mocks.send.mockImplementation(async (path: string) => {
      if (path.includes("provider-models")) current = { ...current, models: [typesafe, candidate] };
      return current;
    });
    await ready();
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main を有効化" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "OpenRouter · Main を無効化" }).getAttribute("aria-checked")).toBe("true"));
    expect(mocks.send).toHaveBeenCalledWith("/api/provider-models/openrouter", { enabled: true, modelIds: ["chat-model"], accountId: "account-1" }, "PATCH");
    expect(mocks.send).not.toHaveBeenCalledWith("/api/jev-model", expect.anything(), "PUT");
    expand("OpenRouter");
    expect((screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を有効化" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not reuse an in-flight catalog read after a shared provider change", async () => {
    let releaseStale!: (value: typeof dto) => void;
    const stale = new Promise<typeof dto>((resolve) => { releaseStale = resolve; });
    const updated = { ...dto, models: [typesafe, { ...candidate, providerEnabled: false }] };
    let reads = 0;
    mocks.get.mockImplementation((_path: string, _params?: unknown, options?: { coalesce?: boolean }) => {
      if (++reads === 1) return Promise.resolve(dto);
      if (reads === 2) return stale;
      return options?.coalesce === false ? Promise.resolve(updated) : stale;
    });
    const { rerender } = render(<JevModelSettings refreshToken={0} />);
    await waitFor(() => expect(screen.queryByText("読み込み中…")).toBeNull());
    rerender(<JevModelSettings refreshToken={1} />);
    rerender(<JevModelSettings refreshToken={2} />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "OpenRouter · Main を有効化" })).toBeTruthy());
    await act(async () => { releaseStale(dto); });
    expect(screen.getByRole("switch", { name: "OpenRouter · Main を有効化" })).toBeTruthy();
  });

  it("ignores an older catalog load after a provider change and fetches the current state", async () => {
    let releaseStale!: (value: typeof dto) => void;
    const stale = new Promise<typeof dto>((resolve) => { releaseStale = resolve; });
    let reads = 0;
    const updated = { ...dto, models: [typesafe, { ...candidate, providerEnabled: false }] };
    mocks.get.mockImplementation((path: string, _params?: unknown, options?: { coalesce?: boolean }) => {
      if (path === "/api/provider-models") return Promise.resolve({ providers: [] });
      if (reads++ === 0) return Promise.resolve(dto);
      return options?.coalesce === false ? Promise.resolve(updated) : stale;
    });
    const { rerender } = render(<JevModelSettings refreshToken={0} />);
    await waitFor(() => expect(screen.queryByText("読み込み中…")).toBeNull());
    rerender(<JevModelSettings refreshToken={1} />);
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main を無効化" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "OpenRouter · Main を有効化" })).toBeTruthy());
    expect(mocks.get).toHaveBeenCalledWith("/api/jev-model", undefined, { coalesce: false });
    await act(async () => { releaseStale(dto); });
    expect(screen.getByRole("switch", { name: "OpenRouter · Main を有効化" })).toBeTruthy();
  });

  it("persists provider and model ordering through the shared catalog", async () => {
    const second = { ...candidate, modelId: "typesafe/jev-1.14", name: "Jev 1.14" };
    let current = { ...dto, models: [typesafe, candidate, second] };
    mocks.get.mockImplementation(async (path: string) => path === "/api/provider-models"
      ? { providers: [{ id: "typesafe", models: [{ id: "regular" }] }, { id: "openrouter", accountId: "account-1", models: [{ id: "chat-model" }] }] }
      : current);
    mocks.send.mockImplementation(async (path: string, body: { providerOrder?: string[]; accountModelOrder?: Record<string, Record<string, string[]>> }) => {
      if (path === "/api/provider-models/order") {
        current = { ...current, models: body.providerOrder
          ? [candidate, second, typesafe]
          : [typesafe, second, candidate] };
      }
      return current;
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "OpenRouter を上へ" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/provider-models/order", { providerOrder: ["account-1::openrouter", "typesafe"] }, "PATCH"));
    await waitFor(() => expect(screen.getAllByRole("switch")[0].getAttribute("aria-label")).toContain("OpenRouter"));
    expand("OpenRouter");
    fireEvent.click(screen.getByRole("button", { name: "OpenRouter の Jev 1.14 を上へ" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/provider-models/order", { accountModelOrder: { "account-1": { openrouter: ["chat-model", "typesafe/jev-1.14", "typesafe/jev-1.13"] } } }, "PATCH"));
  });

  it("supports drag-and-drop reordering as well as arrow buttons", async () => {
    mocks.get.mockImplementation(async (path: string) => path === "/api/provider-models"
      ? { providers: [{ id: "typesafe", models: [] }, { id: "openrouter", accountId: "account-1", models: [] }] }
      : dto);
    await ready();
    const source = screen.getByRole("button", { name: "TypeSafe のモデルを展開" }).closest("li")!;
    const target = screen.getByRole("button", { name: "OpenRouter のモデルを展開" }).closest("li")!;
    fireEvent.dragStart(source, { dataTransfer: { effectAllowed: "move" } });
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/provider-models/order", { providerOrder: ["account-1::openrouter", "typesafe"] }, "PATCH"));
  });

  it("reorders Jev-only providers absent from the ordinary chat catalog", async () => {
    const documented = { providerId: "commandcode", providerName: "Command Code", modelId: "typesafe/jev", name: "Jev", baseUrl: "https://api.commandcode.ai/provider/v1", source: "documented" };
    mocks.get.mockImplementation(async (path: string) => path === "/api/provider-models"
      ? { providers: [{ id: "typesafe", models: [{ id: "regular" }] }, { id: "openrouter", accountId: "account-1", models: [{ id: "chat-model" }] }] }
      : { ...dto, models: [documented, typesafe, candidate] });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Command Code を下へ" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/provider-models/order", { providerOrder: ["typesafe", "commandcode", "account-1::openrouter"] }, "PATCH"));
  });

  it("groups integrated accounts under one provider while retaining account-specific selection", async () => {
    const second = { ...candidate, accountId: "account-2", accountLabel: "Private", providerEnabled: false, integrated: true };
    mocks.get.mockResolvedValue({ ...dto, models: [typesafe, { ...candidate, integrated: true }, second] });
    await ready();
    expect(screen.getAllByRole("button", { name: "OpenRouter のモデルを展開" })).toHaveLength(1);
    expand("OpenRouter");
    expect(screen.getByText("アカウント: Main")).toBeTruthy();
    expect(screen.getByText("アカウント: Private")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "OpenRouter · Private / Jev 1.13 を有効化" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を有効化" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", {
      settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "typesafe", modelId: "jev-latest" }, enabledModels: [{ providerId: "typesafe", modelId: "jev-latest" }, { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" }] },
    }, "PUT"));
  });

  it("refreshes candidates without changing the selection by discovery alone", async () => {
    const documented = { providerId: "commandcode", providerName: "Command Code", modelId: "typesafe/jev", name: "Jev", baseUrl: "https://api.commandcode.ai/provider/v1", source: "documented" };
    mocks.get.mockResolvedValueOnce(dto).mockResolvedValueOnce({ ...dto, models: [typesafe, candidate, documented] });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Command Code のモデルを展開" })).toBeTruthy());
    expect(mocks.get).toHaveBeenCalledWith("/api/jev-model", { refresh: "1" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("keeps the last selected model until a replacement is selected", async () => {
    mocks.get.mockResolvedValue({ ...dto, settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "account-1" } }, models: [typesafe, { ...candidate, providerEnabled: false }] });
    await ready();
    expect(screen.getByRole("alert").textContent).toContain("有効");
    expand("OpenRouter");
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を無効化" }));
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("1件以上残してください"))).toBe(true);
    expand("TypeSafe");
    fireEvent.click(screen.getByRole("switch", { name: "TypeSafe / Jev を有効化" }));
    fireEvent.click(screen.getByRole("switch", { name: "OpenRouter · Main / Jev 1.13 を無効化" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", expect.objectContaining({ settings: expect.objectContaining({ enabledModels: [{ providerId: "typesafe", modelId: "jev-latest" }] }) }), "PUT"));
  });

  it("preserves an old manual endpoint without offering a second provider form", async () => {
    mocks.get.mockResolvedValue({ ...dto, settings: { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "compatible", compatibleBaseUrl: "http://localhost:8080/v1" } });
    await ready();
    expect(screen.getByText(/従来の手動接続先を使用中/)).toBeTruthy();
    expect(screen.queryByLabelText(/APIベースURL|Jev APIキー/)).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not persist an invalid timeout and recovers when corrected", async () => {
    await ready();
    fireEvent.click(screen.getByText("Jev判定の詳細設定"));
    fireEvent.change(screen.getByLabelText("タイムアウト（ミリ秒）"), { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toContain("100〜120000");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("タイムアウト（ミリ秒）"), { target: { value: "4000" } });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  });

  it("auto-saves valid timeout changes and offers retry on failure", async () => {
    mocks.send.mockRejectedValueOnce(new Error("保存失敗"));
    await ready();
    fireEvent.click(screen.getByText("Jev判定の詳細設定"));
    fireEvent.change(screen.getByLabelText("タイムアウト（ミリ秒）"), { target: { value: "4000" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("保存失敗"));
    expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", { settings: { ...DEFAULT_JEV_MODEL_SETTINGS, timeoutMs: 4000 } }, "PUT");
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(screen.getByText(/自動保存しました/)).toBeTruthy());
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
});
