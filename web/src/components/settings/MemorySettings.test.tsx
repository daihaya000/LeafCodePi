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
    sendJson.mockImplementation((url: string, body: unknown) => {
      if (url === "/api/memory-search") {
        return Promise.resolve({
          results: [{
            project: "demo",
            target: "memory",
            category: "convention",
            content: "デプロイ規約はmainから実行する",
            created: "2026-01-01",
            lastReferenced: "2026-02-01",
          }],
        });
      }
      return Promise.resolve({ ...snapshot, settings: body });
    });
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

  it("lets the user search stored memory without an agent turn", async () => {
    render(<MemorySettings />);

    const query = await screen.findByLabelText("検索語");
    fireEvent.change(query, { target: { value: " デプロイ " } });
    fireEvent.click(screen.getByRole("button", { name: "検索" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/memory-search", { query: "デプロイ" }));
    expect(await screen.findByText("デプロイ規約はmainから実行する")).toBeTruthy();
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.getByText("1件見つかりました。")).toBeTruthy();
  });
});
