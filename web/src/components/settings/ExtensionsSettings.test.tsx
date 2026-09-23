// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionsSettings } from "./ExtensionsSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));
vi.mock("@/components/settings/IntercomSettings", () => ({
  IntercomSettings: () => <h3>Intercom受信</h3>,
}));

const staleExtension = {
  id: "leafcode-goal-loop",
  name: "leafcode-goal-loop",
  enabled: false,
  filePath: "C:/LeafCodePi/extensions/leafcode-goal-loop/index.ts",
  source: "user" as const,
  required: true,
};
const intercomExtension = {
  id: "leafcode-intercom",
  name: "leafcode-intercom",
  enabled: true,
  filePath: "C:/LeafCodePi/extensions/leafcode-intercom/index.ts",
  source: "bundled" as const,
  required: true,
};

describe("ExtensionsSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ extensions: [staleExtension], extensionsDir: "C:/pi/agent/extensions" });
    sendJson.mockResolvedValue({
      extensions: [{ ...staleExtension, enabled: true }],
    });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("allows a stale disabled required extension to be enabled", async () => {
    render(<ExtensionsSettings />);

    const toggle = await screen.findByRole("switch", { name: "leafcode-goal-loop を有効化" });
    const list = toggle.closest("ul");
    expect(list?.className).not.toContain("max-h-");
    expect(list?.className).not.toContain("overflow-y-auto");
    expect(list?.className).toContain("@xl:grid-cols-2");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("WebUI が依存するため有効化が必要です")).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/extensions/leafcode-goal-loop",
        { enabled: true },
        "PATCH",
      );
    });
    expect(await screen.findByRole("switch", { name: "leafcode-goal-loop を無効化" })).toBeTruthy();
  });

  it("renders Intercom settings inside the leafcode-intercom extension", async () => {
    getJson.mockResolvedValue({ extensions: [intercomExtension], extensionsDir: "C:/pi/agent/extensions" });

    render(<ExtensionsSettings />);

    const settings = await screen.findByRole("heading", { name: "Intercom受信" });
    expect(settings.closest("li")?.querySelector("#extensions-intercom")).toBe(settings.parentElement);
  });

  it("groups bundled and user extensions into separate sections", async () => {
    getJson.mockResolvedValue({
      extensions: [staleExtension, intercomExtension],
      extensionsDir: "C:/pi/agent/extensions",
      bundledExtensionsDir: "C:/LeafCodePi/extensions",
    });

    render(<ExtensionsSettings />);

    await screen.findByRole("switch", { name: "leafcode-goal-loop を有効化" });
    const bundledPanel = screen.getByTestId("extensions-bundled");
    const userPanel = screen.getByTestId("extensions-user");
    const bundled = within(bundledPanel);
    const user = within(userPanel);
    expect(bundledPanel.className).toMatch(/\bbg-surface\b/);
    expect(userPanel.className).toMatch(/\bbg-surface\b/);
    expect(bundledPanel.className).not.toMatch(/\bbg-surface-2\b/);
    expect(userPanel.className).not.toMatch(/\bbg-surface-2\b/);
    expect(bundled.getByRole("heading", { name: "組み込み" })).toBeTruthy();
    expect(bundled.getByText("C:/LeafCodePi/extensions")).toBeTruthy();
    expect(bundled.getByText("leafcode-intercom")).toBeTruthy();
    expect(user.getByText("C:/pi/agent/extensions")).toBeTruthy();
    expect(user.getByText("leafcode-goal-loop")).toBeTruthy();
    expect(screen.queryByText("LeafCodePi リポジトリに同梱された拡張機能です。")).toBeNull();
    expect(screen.queryByText("ユーザーの Pi 設定から読み込んだ拡張機能です。")).toBeNull();
  });
});
