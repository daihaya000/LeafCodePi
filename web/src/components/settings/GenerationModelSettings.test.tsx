// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationModelSettings } from "./GenerationModelSettings";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  readGenerationFallbackModel: vi.fn(),
  readGenerationFallbackModelEffort: vi.fn(),
  readGenerationFallbackModelEffortFromServer: vi.fn(),
  readGenerationFallbackModelFromServer: vi.fn(),
  readGenerationModel: vi.fn(),
  readGenerationModelFromServer: vi.fn(),
  readGenerationModelEffort: vi.fn(),
  readGenerationModelEffortFromServer: vi.fn(),
  writeGenerationFallbackModel: vi.fn(),
  writeGenerationFallbackModelEffort: vi.fn(),
  writeGenerationFallbackModelEffortToServer: vi.fn(),
  writeGenerationFallbackModelToServer: vi.fn(),
  writeGenerationModel: vi.fn(),
  writeGenerationModelToServer: vi.fn(),
  writeGenerationModelEffort: vi.fn(),
  writeGenerationModelEffortToServer: vi.fn(),
}));

vi.mock("@/lib/client", () => ({
  ApiError: class ApiError extends Error {},
  getJson: mocks.getJson,
}));
vi.mock("@/lib/generation-model", () => mocks);

describe("GenerationModelSettings", () => {
  beforeEach(() => {
    mocks.getJson.mockResolvedValue({
      models: [
        {
          value: "anthropic::claude-sonnet",
          label: "Claude Sonnet",
          providerID: "anthropic",
          modelID: "claude-sonnet",
          thinkingLevels: ["low", "high"],
        },
      ],
    });
    mocks.readGenerationModel.mockReturnValue(null);
    mocks.readGenerationModelFromServer.mockResolvedValue("anthropic::claude-sonnet");
    mocks.readGenerationModelEffort.mockReturnValue(null);
    mocks.readGenerationModelEffortFromServer.mockResolvedValue("low");
    mocks.readGenerationFallbackModel.mockReturnValue(null);
    mocks.readGenerationFallbackModelFromServer.mockResolvedValue(null);
    mocks.readGenerationFallbackModelEffort.mockReturnValue(null);
    mocks.readGenerationFallbackModelEffortFromServer.mockResolvedValue(null);
    mocks.writeGenerationModelToServer.mockResolvedValue(undefined);
    mocks.writeGenerationModelEffortToServer.mockResolvedValue(undefined);
    mocks.writeGenerationFallbackModelToServer.mockResolvedValue(undefined);
    mocks.writeGenerationFallbackModelEffortToServer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it("モデル一覧取得後に選択UIを有効化する", async () => {
    let resolveModels!: (result: { models: unknown[] }) => void;
    const modelRequest = new Promise<{ models: unknown[] }>((resolve) => {
      resolveModels = resolve;
    });
    mocks.getJson.mockImplementation((path: string) =>
      path === "/api/models" ? modelRequest : Promise.resolve({}),
    );

    render(<GenerationModelSettings />);
    const modelSelect = screen.getByRole("button", { name: "生成モデル" }) as HTMLButtonElement;
    expect(modelSelect.disabled).toBe(true);

    resolveModels({
      models: [
        {
          value: "anthropic::claude-sonnet",
          label: "Claude Sonnet",
          providerID: "anthropic",
          modelID: "claude-sonnet",
        },
      ],
    });

    await waitFor(() => expect(modelSelect.disabled).toBe(false));
  });

  it("refreshes models without resetting the selected model", async () => {
    const { rerender } = render(<GenerationModelSettings refreshToken={0} />);
    const modelSelect = await screen.findByRole("button", { name: "生成モデル" });
    fireEvent.click(modelSelect);
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet" }));
    expect(modelSelect.textContent).toContain("Claude Sonnet");
    const initialRequestCount = mocks.getJson.mock.calls.length;

    rerender(<GenerationModelSettings refreshToken={1} />);

    await waitFor(() => {
      expect(mocks.getJson).toHaveBeenCalledTimes(initialRequestCount + 1);
    });
    expect(modelSelect.textContent).toContain("Claude Sonnet");
  });

  it("restores and persists the selected generation effort", async () => {
    render(<GenerationModelSettings />);

    expect(screen.getByRole("heading", { name: "生成モデル" })).toBeTruthy();
    const effort = await screen.findByRole("button", { name: "生成モデルのEffort" });
    expect(effort.textContent).toContain("low");

    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: "high" }));

    await waitFor(() => {
      expect(mocks.writeGenerationModelEffort).toHaveBeenCalledWith("high");
      expect(mocks.writeGenerationModelEffortToServer).toHaveBeenCalledWith("high");
    });
  });

  it("normalizes an old account-specific setting after switching to integrated mode", async () => {
    mocks.getJson.mockResolvedValue({
      models: [
        {
          value: "anthropic::claude-sonnet",
          label: "Claude Sonnet",
          providerID: "anthropic",
          modelID: "claude-sonnet",
          routingMode: "integrated",
        },
      ],
    });
    mocks.readGenerationModelFromServer.mockResolvedValue("acc-1::anthropic::claude-sonnet");

    render(<GenerationModelSettings />);

    await waitFor(() => {
      expect(mocks.writeGenerationModelToServer).toHaveBeenCalledWith("anthropic::claude-sonnet");
    });
  });

  it("restores the fallback model and its effort", async () => {
    mocks.readGenerationFallbackModelFromServer.mockResolvedValue("anthropic::claude-sonnet");
    mocks.readGenerationFallbackModelEffortFromServer.mockResolvedValue("high");

    render(<GenerationModelSettings />);

    const fallbackEffort = await screen.findByRole("button", { name: "フォールバック先のEffort" });
    expect(fallbackEffort.textContent).toContain("high");
  });

  it("localStorageに保存値があってもサーバー相当レンダーは設定値に依存しない", () => {
    mocks.readGenerationModel.mockReturnValue("anthropic::claude-sonnet");
    mocks.readGenerationModelEffort.mockReturnValue("low");

    const html = renderToStaticMarkup(<GenerationModelSettings />);
    // モデル一覧取得前は選択UIが無効表示なので、localStorageのモデル名・Effortは出ない。
    expect(html).not.toContain("Claude Sonnet");
    expect(html).not.toContain("低");
    expect(html).toContain("モデルなし");
  });
});
