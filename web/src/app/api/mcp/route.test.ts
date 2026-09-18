import { NextRequest } from "next/server";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  reloadLiveSessionsContext: vi.fn(async () => ({ reloaded: 1 })),
}));

vi.mock("@/lib/pi/harness", () => harness);

import { POST } from "./route";

function request(body?: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/mcp", {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/mcp POST", () => {
  let agentDir = "";
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-mcp-route-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    harness.reloadLiveSessionsContext.mockClear();
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("adds n8n as an OAuth server and returns the refreshed list", async () => {
    const response = await POST(request({ preset: "n8n", url: "example.app.n8n.cloud" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; servers?: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.servers).toEqual([
      expect.objectContaining({ id: "n8n", source: "http", authType: "oauth", enabled: true }),
    ]);
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledTimes(1);

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers.n8n).toEqual({
      url: "https://example.app.n8n.cloud/mcp-server/http",
      auth: "oauth",
      httpTransport: "streamable-http",
      protocolVersion: "auto",
    });
  });

  it("adds slack with a pre-registered client ID", async () => {
    const response = await POST(request({ preset: "slack", clientId: "1601185624273.8899143856786" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; servers?: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.servers).toEqual([
      expect.objectContaining({ id: "slack", authType: "oauth", enabled: true }),
    ]);

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers.slack.url).toBe("https://mcp.slack.com/mcp");
    expect(raw.mcpServers.slack.oauth.clientId).toBe("1601185624273.8899143856786");
  });

  it("adds the Google Workspace server group", async () => {
    const response = await POST(request({
      preset: "google-workspace",
      clientId: "abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret",
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; servers?: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.servers).toHaveLength(8);

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers["gws-calendar"].url).toBe("https://calendarmcp.googleapis.com/mcp/v1");
    expect(raw.mcpServers["gws-calendar"].oauth.scope).toContain("calendar.events.readonly");
  });

  it("adds notion", async () => {
    const response = await POST(request({ preset: "notion" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; servers?: unknown[] };
    expect(body.servers).toEqual([
      expect.objectContaining({ id: "notion", authType: "oauth", enabled: true }),
    ]);

    const raw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(raw.mcpServers.notion.url).toBe("https://mcp.notion.com/mcp");
  });

  it("rejects unsupported presets and duplicate registrations", async () => {
    const unsupported = await POST(request({ preset: "other", url: "https://example.com" }));
    expect(unsupported.status).toBe(400);

    await POST(request({ preset: "n8n", url: "example.app.n8n.cloud" }));
    const duplicate = await POST(request({ preset: "n8n", url: "example.app.n8n.cloud" }));
    expect(duplicate.status).toBe(409);
  });

  it("rejects invalid request bodies", async () => {
    const notJson = new NextRequest("http://127.0.0.1:3010/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await POST(notJson)).status).toBe(400);
    expect((await POST(request({ preset: "n8n" }))).status).toBe(400);
    expect((await POST(request({ preset: "slack" }))).status).toBe(400);
    expect((await POST(request({ preset: "google-workspace" }))).status).toBe(400);
    expect((await POST(request({ preset: "google-workspace", clientId: "x" }))).status).toBe(400);
  });
});
