// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationModelSettings } from "./GenerationModelSettings";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  readGenerationModel: vi.fn(),
  readGenerationModelFromServer: vi.fn(),
  readGenerationModelEffort: vi.fn(),
  readGenerationModelEffortFromServer: vi.fn(),
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
    mocks.writeGenerationModelToServer.mockResolvedValue(undefined);
    mocks.writeGenerationModelEffortToServer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it("restores and persists the selected generation effort", async () => {
    render(<GenerationModelSettings />);

    expect(screen.getByRole("heading", { name: /コミットメッセージ 生成モデル/ })).toBeTruthy();
    const effort = await screen.findByRole("button", { name: "生成モデルのEffort" });
    expect(effort.textContent).toContain("low");

    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: "high" }));

    await waitFor(() => {
      expect(mocks.writeGenerationModelEffort).toHaveBeenCalledWith("high");
      expect(mocks.writeGenerationModelEffortToServer).toHaveBeenCalledWith("high");
    });
  });
});
