// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationSettings } from "./CollaborationSettings";
import { DEFAULT_COLLABORATION_CONFIG } from "@/lib/collaboration-schema";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const snapshot = {
  config: { ...DEFAULT_COLLABORATION_CONFIG, mode: "strict" as const },
  valid: true,
  path: "C:/Users/test/AppData/Roaming/leafcode-pi/collaboration.json",
  exists: false,
};

describe("CollaborationSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue(snapshot);
    sendJson.mockImplementation((_url: string, config: unknown) => Promise.resolve({ ...snapshot, exists: true, config }));
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("loads collaboration config and saves mode plus timing", async () => {
    render(<CollaborationSettings />);

    expect(await screen.findByRole("heading", { name: "協調" })).toBeTruthy();
    expect(await screen.findByRole("radio", { name: /厳格/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /緩和/ }));
    fireEvent.change(screen.getByLabelText("リース TTL"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledTimes(1);
    });
    const [, body, method] = sendJson.mock.calls[0] as [string, { mode: string; leaseTtlMs: number }, string];
    expect(method).toBe("PUT");
    expect(body.mode).toBe("permissive");
    expect(body.leaseTtlMs).toBe(30_000);
    expect(await screen.findByText(/保存しました/)).toBeTruthy();
  });

  it("turns collaboration completely off", async () => {
    render(<CollaborationSettings />);

    fireEvent.click(await screen.findByRole("radio", { name: /OFF/ }));
    expect(screen.queryByLabelText("ハートビート")).toBeNull();
    expect(screen.getByText(/協調機能を読み込みません/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledTimes(1));
    const [, body] = sendJson.mock.calls[0] as [string, { mode: string }];
    expect(body.mode).toBe("off");
    expect((screen.getByRole("radio", { name: /OFF/ }) as HTMLInputElement).checked).toBe(true);
  });
});
