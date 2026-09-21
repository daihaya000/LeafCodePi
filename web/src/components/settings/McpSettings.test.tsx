// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => client);

import { McpSettings } from "./McpSettings";

const server = {
  id: "n8n",
  name: "n8n",
  enabled: true,
  bundled: true,
  userConfigured: true,
  source: "http" as const,
  url: "https://n8n.example.com/mcp",
  authType: "bearer" as const,
  credentialConfigured: false,
  credentialSource: "environment" as const,
  credentialStatus: "missing" as const,
};

const auth = {
  name: "n8n",
  configPath: "C:\\Users\\test\\.pi\\agent\\mcp.json",
  url: server.url,
  authType: "bearer" as const,
  credentialConfigured: true,
  credentialSource: "secure-store" as const,
  credentialStatus: "present" as const,
};

const listResponse = { servers: [server], configPath: auth.configPath };

describe("McpSettings", () => {
  beforeEach(() => {
    client.getJson.mockImplementation((path: string) =>
      path.endsWith("/auth") ? Promise.resolve(auth) : Promise.resolve(listResponse),
    );
    client.sendJson.mockResolvedValue({ ok: true, auth });
  });

  afterEach(() => {
    cleanup();
    client.getJson.mockReset();
    client.sendJson.mockReset();
  });

  it("opens the auth editor and saves bearer tokens through the API", async () => {
    render(<McpSettings />);
    await screen.findByText("n8n");

    fireEvent.click(screen.getByRole("button", { name: "認証設定" }));
    const token = "secret-token-should-not-be-rendered";
    const input = await screen.findByLabelText("n8n のBearerトークン");
    fireEvent.change(input, { target: { value: token } });
    fireEvent.click(within(screen.getByTestId("mcp-bearer-n8n")).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(client.sendJson).toHaveBeenCalledWith(
      "/api/mcp/n8n/auth",
      { type: "bearer", token },
      "POST",
    ));
    await waitFor(() => expect(screen.queryByDisplayValue(token)).toBeNull());
    expect(screen.queryByText(token)).toBeNull();
  });

  it("reflects a server toggle before the API response", async () => {
    let resolveRequest!: (value: unknown) => void;
    const request = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    client.sendJson.mockReturnValueOnce(request);

    render(<McpSettings />);
    fireEvent.click(await screen.findByRole("switch", { name: "n8n を無効化" }));

    const toggle = screen.getByRole("switch", { name: "n8n を有効化" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    resolveRequest({ servers: [{ ...server, enabled: false }] });
    await waitFor(() => expect(screen.getByRole("switch", { name: "n8n を有効化" })).toBeTruthy());
  });

  it("does not render the retired user-add menu", async () => {
    render(<McpSettings />);
    await screen.findByText("n8n");

    expect(screen.queryByTestId("mcp-add")).toBeNull();
    expect(screen.queryByText("ユーザー追加")).toBeNull();
  });
});
