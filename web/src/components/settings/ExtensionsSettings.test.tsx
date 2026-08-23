// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionsSettings } from "./ExtensionsSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const staleExtension = {
  id: "leafcode-collaboration",
  name: "leafcode-collaboration",
  enabled: false,
  filePath: "C:/LeafCodePi/extensions/leafcode-collaboration/index.ts",
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

    const toggle = await screen.findByRole("switch", { name: "leafcode-collaboration を有効化" });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("WebUI が依存するため有効化が必要です")).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/extensions/leafcode-collaboration",
        { enabled: true },
        "PATCH",
      );
    });
    expect(await screen.findByRole("switch", { name: "leafcode-collaboration を無効化" })).toBeTruthy();
  });
});
