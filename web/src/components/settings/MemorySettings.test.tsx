// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettings } from "./MemorySettings";
import { DEFAULT_LEAFCODE_MEMORY_SETTINGS } from "@/lib/leafcode-memory-schema";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const snapshot = {
  settings: DEFAULT_LEAFCODE_MEMORY_SETTINGS,
  path: "C:/Users/test/.pi/agent/leafcode-memory-config.json",
  exists: true,
  valid: true,
  writable: true,
};

describe("MemorySettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue(snapshot);
    sendJson.mockImplementation((_url: string, body: unknown) => Promise.resolve({ ...snapshot, settings: body }));
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("loads memory parameters and saves an edited value", async () => {
    render(<MemorySettings />);

    const limit = await screen.findByLabelText("グローバル");
    expect((limit as HTMLInputElement).value).toBe("5000");

    fireEvent.change(limit, { target: { value: "8000" } });
    expect(screen.getByText("未保存")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledTimes(1));
    const [url, body, method] = sendJson.mock.calls[0] as [string, { memoryCharLimit: number }, string];
    expect(url).toBe("/api/memory-settings");
    expect(method).toBe("PUT");
    expect(body.memoryCharLimit).toBe(8_000);
    expect(await screen.findByText(/新しいセッションまたはホスト再起動/)).toBeTruthy();
  });
});
