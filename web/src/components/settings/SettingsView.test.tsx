// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }));

vi.mock("@/lib/client", () => ({ getJson }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuHeader: () => null }));
vi.mock("@/components/settings/HostRestartPanel", () => ({ HostRestartPanel: () => null }));
vi.mock("@/components/settings/LlamaServerSettings", () => ({ LlamaServerSettings: () => null }));
vi.mock("@/components/settings/ProviderModelsPanel", () => ({
  ProviderModelsPanel: () => <h2>モデル</h2>,
}));
vi.mock("@/components/settings/ProviderAuthPanel", () => ({
  ProviderAuthPanel: () => <h2>プロバイダ</h2>,
}));
vi.mock("@/components/settings/GenerationModelSettings", () => ({
  GenerationModelSettings: () => <h2>生成モデル</h2>,
}));

describe("SettingsView", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ providers: [] });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
  });

  it("モデルタブをモデル、プロバイダ、生成モデルの順に表示する", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /^モデル$/ }));

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "モデル",
      "プロバイダ",
      "生成モデル",
    ]);
  });
});
