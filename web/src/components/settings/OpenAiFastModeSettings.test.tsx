// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiFastModeSettings } from "./OpenAiFastModeSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("OpenAiFastModeSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ value: null });
    sendJson.mockResolvedValue({});
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads the stored value and saves toggles", async () => {
    getJson.mockResolvedValue({ value: "1" });
    render(<OpenAiFastModeSettings />);
    const toggle = await screen.findByRole("switch", { name: "OpenAI Fastモード" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith("/api/settings/openai-fast-mode", { value: "" }, "PUT"),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reverts the toggle when saving fails", async () => {
    sendJson.mockRejectedValue(new Error("保存失敗"));
    render(<OpenAiFastModeSettings />);
    const toggle = await screen.findByRole("switch", { name: "OpenAI Fastモード" });
    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toBe("保存失敗");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
