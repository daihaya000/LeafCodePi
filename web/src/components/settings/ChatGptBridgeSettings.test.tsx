// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGptBridgeSettings } from "./ChatGptBridgeSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const projects = [
  { id: "project-1", name: "Demo", rootPath: "C:/private", favorite: false, archived: false, createdAt: "", lastOpenedAt: null },
  { id: "project-2", name: "Archived", rootPath: "C:/archived", favorite: false, archived: true, createdAt: "", lastOpenedAt: null },
];

const ready = {
  ok: true,
  enabled: false,
  artifactReady: true,
  cloudflaredAvailable: true,
  state: "disabled",
  projectId: "project-1",
  projectName: "Demo",
  connected: false,
  verified: false,
  tunnelRunning: false,
  pairingActive: false,
} as const;

describe("ChatGptBridgeSettings", () => {
  beforeEach(() => {
    getJson.mockImplementation((path: string) => {
      if (path === "/api/projects") return Promise.resolve({ projects });
      return Promise.resolve(ready);
    });
    sendJson.mockReset();
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("loads only active projects and keeps workspace paths out of the UI", async () => {
    render(<ChatGptBridgeSettings />);

    await waitFor(() => expect(screen.getByText("ChatGPTプラン・レビュー連携")).toBeTruthy());
    expect(screen.getByRole("option", { name: "Demo" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Archived" })).toBeNull();
    expect(screen.queryByText("C:/private")).toBeNull();
  });

  it("enables the opt-in flag without starting a Bridge", async () => {
    sendJson.mockResolvedValue({ ok: true, enabled: true });
    render(<ChatGptBridgeSettings />);

    await waitFor(() => expect(screen.getByRole("switch", { name: "ChatGPT連携を有効にする" })).toBeTruthy());
    fireEvent.click(screen.getByRole("switch", { name: "ChatGPT連携を有効にする" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/chatgpt-bridge/enabled",
      { enabled: true },
    ));
    expect(sendJson).not.toHaveBeenCalledWith("/api/chatgpt-bridge/setup", expect.anything());
  });

  it("saves only an allowlisted ChatGPT conversation URL", async () => {
    sendJson.mockResolvedValue({ ok: true, projectId: "project-1", conversationUrl: "https://chatgpt.com/c/demo" });
    render(<ChatGptBridgeSettings />);

    await waitFor(() => expect(screen.getByLabelText("ChatGPT会話URL（任意）")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("ChatGPT会話URL（任意）"), { target: { value: "https://chatgpt.com/c/demo" } });
    fireEvent.click(screen.getByRole("button", { name: "URLを保存" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/chatgpt-bridge/session",
      { projectId: "project-1", conversationUrl: "https://chatgpt.com/c/demo" },
      "PATCH",
    ));
  });

  it("shows a pairing code returned by Host", async () => {
    getJson.mockImplementation((path: string) => {
      if (path === "/api/projects") return Promise.resolve({ projects });
      return Promise.resolve({ ...ready, enabled: true, state: "connected", connected: true, tunnelRunning: true });
    });
    sendJson.mockResolvedValue({
      ok: true,
      projectId: "project-1",
      connectionUrl: "https://example.trycloudflare.com/mcp",
      pairingCode: "ABCD-EFGH",
      pairingExpiresAt: Date.now() + 300_000,
    });
    render(<ChatGptBridgeSettings />);

    await waitFor(() => expect(screen.getByRole("button", { name: "配布コードを発行" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "配布コードを発行" }));

    await waitFor(() => expect(screen.getByText("ABCD-EFGH")).toBeTruthy());
    expect(screen.getAllByText("https://example.trycloudflare.com/mcp").length).toBeGreaterThan(0);
  });
});
