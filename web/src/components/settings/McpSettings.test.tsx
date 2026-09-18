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

  it("adds n8n through the API and opens its OAuth panel", async () => {
    const oauthServer = {
      ...server,
      authType: "oauth" as const,
      credentialConfigured: false,
      credentialSource: "oauth" as const,
      credentialStatus: "missing" as const,
    };
    const oauthAuth = {
      ...auth,
      authType: "oauth" as const,
      credentialSource: "oauth" as const,
      credentialStatus: "missing" as const,
    };
    client.getJson.mockImplementation((path: string) =>
      path.endsWith("/auth")
        ? Promise.resolve(oauthAuth)
        : Promise.resolve({ servers: [], configPath: auth.configPath }),
    );
    client.sendJson.mockResolvedValue({ ok: true, servers: [oauthServer] });

    render(<McpSettings />);
    const input = await screen.findByLabelText("n8n のURL");
    fireEvent.change(input, { target: { value: "https://example.app.n8n.cloud" } });
    fireEvent.click(screen.getByRole("button", { name: "n8n を追加" }));

    await waitFor(() => expect(client.sendJson).toHaveBeenCalledWith(
      "/api/mcp",
      { preset: "n8n", url: "https://example.app.n8n.cloud" },
      "POST",
    ));
    expect(await screen.findByRole("button", { name: "OAuth認証を開始" })).toBeTruthy();
  });

  it("adds slack through the API and opens its OAuth panel", async () => {
    const slackServer = {
      ...server,
      id: "slack",
      name: "slack",
      authType: "oauth" as const,
      credentialConfigured: false,
      credentialSource: "oauth" as const,
      credentialStatus: "missing" as const,
    };
    const slackAuth = {
      ...auth,
      name: "slack",
      authType: "oauth" as const,
      credentialSource: "oauth" as const,
      credentialStatus: "missing" as const,
    };
    client.getJson.mockImplementation((path: string) =>
      path.endsWith("/auth")
        ? Promise.resolve(slackAuth)
        : Promise.resolve({ servers: [server], configPath: auth.configPath }),
    );
    client.sendJson.mockResolvedValue({ ok: true, servers: [server, slackServer] });

    render(<McpSettings />);
    const input = await screen.findByLabelText("Slack のClient ID");
    fireEvent.change(input, { target: { value: "1601185624273.8899143856786" } });
    fireEvent.click(screen.getByRole("button", { name: "Slack を追加" }));

    await waitFor(() => expect(client.sendJson).toHaveBeenCalledWith(
      "/api/mcp",
      { preset: "slack", clientId: "1601185624273.8899143856786" },
      "POST",
    ));
    expect(await screen.findByRole("button", { name: "OAuth認証を開始" })).toBeTruthy();
  });

  it("adds the Google Workspace group through the API", async () => {
    const gwsServer = {
      ...server,
      id: "gws-gmail",
      name: "gws-gmail",
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      authType: "oauth" as const,
      credentialConfigured: false,
      credentialSource: "oauth" as const,
      credentialStatus: "missing" as const,
    };
    client.getJson.mockImplementation((path: string) =>
      path.endsWith("/auth")
        ? Promise.resolve({
            ...auth,
            name: "gws-gmail",
            authType: "oauth" as const,
            credentialSource: "oauth" as const,
            credentialStatus: "missing" as const,
          })
        : Promise.resolve({ servers: [server], configPath: auth.configPath }),
    );
    client.sendJson.mockResolvedValue({ ok: true, servers: [server, gwsServer] });

    render(<McpSettings />);
    const idInput = await screen.findByLabelText("Google Workspace のClient ID");
    const secretInput = screen.getByLabelText("Google Workspace のClient Secret");
    fireEvent.change(idInput, { target: { value: "abc.apps.googleusercontent.com" } });
    fireEvent.change(secretInput, { target: { value: "GOCSPX-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Google Workspace を追加" }));

    await waitFor(() => expect(client.sendJson).toHaveBeenCalledWith(
      "/api/mcp",
      { preset: "google-workspace", clientId: "abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" },
      "POST",
    ));
  });

  it("adds notion through the API and opens its OAuth panel", async () => {
    const notionServer = {
      ...server,
      id: "notion",
      name: "notion",
      url: "https://mcp.notion.com/mcp",
      authType: "oauth" as const,
      credentialConfigured: false,
      credentialSource: "oauth" as const,
      credentialStatus: "missing" as const,
    };
    const notionAuth = {
      ...auth,
      name: "notion",
      url: notionServer.url,
      authType: "oauth" as const,
      credentialSource: "oauth" as const,
      credentialStatus: "missing" as const,
    };
    client.getJson.mockImplementation((path: string) =>
      path.endsWith("/auth")
        ? Promise.resolve(notionAuth)
        : Promise.resolve({ servers: [server], configPath: auth.configPath }),
    );
    client.sendJson.mockResolvedValue({ ok: true, servers: [server, notionServer] });

    render(<McpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Notion を追加" }));

    await waitFor(() => expect(client.sendJson).toHaveBeenCalledWith("/api/mcp", { preset: "notion" }, "POST"));
    expect(await screen.findByRole("button", { name: "OAuth認証を開始" })).toBeTruthy();
  });
});
