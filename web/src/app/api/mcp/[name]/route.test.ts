import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  reloadLiveSessionsContext: vi.fn(),
}));
const mcp = vi.hoisted(() => ({
  listMcpServers: vi.fn(),
  mcpErrorStatus: vi.fn(() => 500),
  setMcpServerEnabled: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => harness);
vi.mock("@/lib/mcp", () => mcp);

import { PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/mcp/n8n", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ name: "n8n" }) };
}

describe("/api/mcp/:name", () => {
  beforeEach(() => {
    harness.reloadLiveSessionsContext.mockReset();
    mcp.listMcpServers.mockReset();
    mcp.mcpErrorStatus.mockReset();
    mcp.mcpErrorStatus.mockReturnValue(500);
    mcp.setMcpServerEnabled.mockReset();
    mcp.listMcpServers.mockReturnValue({
      servers: [{ id: "n8n", name: "n8n", enabled: false }],
      configPath: "C:/pi/mcp.json",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ライブセッションの再読込完了を待たずに状態を返す", async () => {
    let resolveReload!: (value: unknown) => void;
    const reload = new Promise((resolve) => {
      resolveReload = resolve;
    });
    harness.reloadLiveSessionsContext.mockReturnValueOnce(reload);

    const responsePromise = PATCH(request({ enabled: false }), context());
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timeoutTimer = setTimeout(() => resolve(null), 25);
    });
    const response = await Promise.race([responsePromise, timeout]);
    if (timeoutTimer) clearTimeout(timeoutTimer);

    expect(response).not.toBeNull();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledOnce();
    expect(mcp.setMcpServerEnabled).toHaveBeenCalledWith("n8n", false);
    expect(await (response as Response).json()).toMatchObject({
      ok: true,
      name: "n8n",
      enabled: false,
      servers: [{ id: "n8n", enabled: false }],
    });

    resolveReload({ reloaded: 1, deferred: 0, failed: 0, errors: [] });
    await responsePromise;
  });
});
