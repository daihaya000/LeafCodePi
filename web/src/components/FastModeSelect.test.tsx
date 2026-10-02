// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FastModeSelect } from "./FastModeSelect";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("FastModeSelect", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ value: null });
    sendJson.mockResolvedValue({});
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders nothing and skips loading for non-OpenAI providers", () => {
    const { container } = render(<FastModeSelect providerID="anthropic" />);
    expect(container.innerHTML).toBe("");
    expect(getJson).not.toHaveBeenCalled();
  });

  it("shows the stored state and saves the selection for OpenAI models", async () => {
    getJson.mockResolvedValue({ value: "1" });
    render(<FastModeSelect providerID="openai-codex" />);
    const trigger = await screen.findByRole("button", { name: "処理速度" });
    await waitFor(() => expect(trigger.textContent).toContain("Fast"));
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "標準" }));
    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith("/api/settings/openai-fast-mode", { value: "" }, "PUT"),
    );
    await waitFor(() => expect(trigger.textContent).toContain("標準"));
  });
});
