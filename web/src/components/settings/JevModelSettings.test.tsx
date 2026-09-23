// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS } from "@/lib/jev-model-settings";
import { JevModelSettings } from "./JevModelSettings";

const mocks = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.get, sendJson: mocks.send }));
const dto = { settings: { ...DEFAULT_JEV_MODEL_SETTINGS }, hasApiKey: { typesafe: true, compatible: false } };

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

describe("JevModelSettings", () => {
  it("shows a dedicated judgment model, not a Composer model", async () => {
    await ready();
    expect(screen.getByRole("heading", { name: "Jevモデル" })).toBeTruthy();
    expect(screen.getByText(/Composerには表示しません/)).toBeTruthy();
    expect((screen.getByLabelText("JevモデルID") as HTMLInputElement).value).toBe("jev-latest");
    expect((screen.getByLabelText("Jev APIキー") as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText(/APIベースURL/)).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("saves a compatible endpoint and model only on explicit save and clears the key field", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Jevプロバイダー"), { target: { value: "compatible" } });
    fireEvent.change(screen.getByLabelText(/APIベースURL/), { target: { value: "http://localhost:8080/v1" } });
    fireEvent.change(screen.getByLabelText("JevモデルID"), { target: { value: "my-judge" } });
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

  it("retains custom connection fields when switching back and does not transfer the draft key", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Jevプロバイダー"), { target: { value: "compatible" } });
    fireEvent.change(screen.getByLabelText(/APIベースURL/), { target: { value: "http://localhost:8080/v1" } });
    fireEvent.change(screen.getByLabelText(/Jev APIキー/), { target: { value: "test-only-key" } });
    fireEvent.change(screen.getByLabelText("Jevプロバイダー"), { target: { value: "typesafe" } });
    expect((screen.getByLabelText(/Jev APIキー/) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Jevモデルを保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/jev-model", {
      settings: { ...DEFAULT_JEV_MODEL_SETTINGS, compatibleBaseUrl: "http://localhost:8080/v1" },
    }, "PUT"));
  });

  it("sends null only when deleting a saved credential", async () => {
    await ready();
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
