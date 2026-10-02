import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ reloadLiveSessionsContext: vi.fn() }));
const mcp = vi.hoisted(() => ({ listMcpServers: vi.fn(), mcpErrorStatus: vi.fn(() => 500), setMcpServerEnabled: vi.fn() }));
const owner = vi.hoisted(() => ({ localRuntimeBlocked: vi.fn(), setMcpServerEnabledOnBackend: vi.fn() }));
vi.mock("@/lib/live-context", () => harness);
vi.mock("@/lib/mcp", () => mcp);
vi.mock("@/lib/pi/runtime-ownership", () => ({ localRuntimeBlocked: owner.localRuntimeBlocked }));
vi.mock("@/lib/backend-client", () => ({ setMcpServerEnabledOnBackend: owner.setMcpServerEnabledOnBackend }));
import { PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/mcp/n8n", { method: "PATCH",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const context = (name = "n8n") => ({ params: Promise.resolve({ name }) });
const servers = [{ id: "n8n", name: "n8n", enabled: false }];
function expectNoLocalWork() {
  expect(mcp.setMcpServerEnabled).not.toHaveBeenCalled();
  expect(mcp.listMcpServers).not.toHaveBeenCalled();
  expect(harness.reloadLiveSessionsContext).not.toHaveBeenCalled();
}

describe("/api/mcp/:name", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mcp.mcpErrorStatus.mockReturnValue(500);
    mcp.listMcpServers.mockReturnValue({ servers, configPath: "C:/pi/mcp.json" });
    owner.localRuntimeBlocked.mockReturnValue(false);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("development responds without waiting for the local live-session reload", async () => {
    let resolveReload!: (value: unknown) => void;
    harness.reloadLiveSessionsContext.mockReturnValueOnce(new Promise((resolve) => { resolveReload = resolve; }));
    const response = await PATCH(request({ enabled: false }), context());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.reloadLiveSessionsContext).toHaveBeenCalledOnce();
    expect(mcp.setMcpServerEnabled).toHaveBeenCalledWith("n8n", false);
    expect(await response.json()).toMatchObject({ ok: true, name: "n8n", enabled: false, servers });
    expect(owner.setMcpServerEnabledOnBackend).not.toHaveBeenCalled();
    resolveReload({ reloaded: 1, deferred: 0, failed: 0, errors: [] });
  });

  it("production forwards ON/OFF without local writes, reads or duplicate reload and drops owner internals", async () => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.setMcpServerEnabledOnBackend.mockResolvedValue({ ok: true, status: 200,
      body: { ok: true, name: "n8n", enabled: false, servers, configPath: "private-owner-path", token: "private-fixture-token" } });
    const response = await PATCH(request({ enabled: false }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, name: "n8n", enabled: false, servers });
    expect(owner.setMcpServerEnabledOnBackend).toHaveBeenCalledWith("n8n", false);
    expectNoLocalWork();
  });

  it.each([
    ["not-configured", undefined, 502], ["timeout", undefined, 502], ["unreachable", undefined, 502],
    ["unauthorized", 401, 401], ["incompatible", 409, 409], ["bad-response", 404, 404],
  ])("does not fall back when the Backend reports %s", async (reason, status, expected) => {
    owner.localRuntimeBlocked.mockReturnValue(true);
    owner.setMcpServerEnabledOnBackend.mockResolvedValue({ ok: false, reason, status, error: "private-fixture-token" });
    const response = await PATCH(request({ enabled: false }), context());
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("private-fixture-token");
    expectNoLocalWork();
  });

  it.each([null, { ok: false }, { ok: true, name: "other", enabled: false, servers },
    { ok: true, name: "n8n", enabled: true, servers }, { ok: true, name: "n8n", enabled: false, servers: {} }])(
    "rejects malformed success responses without local fallback", async (body) => {
      owner.localRuntimeBlocked.mockReturnValue(true);
      owner.setMcpServerEnabledOnBackend.mockResolvedValue({ ok: true, body });
      expect((await PATCH(request({ enabled: false }), context())).status).toBe(502);
      expectNoLocalWork();
    });

  it.each([null, [], {}, { enabled: "false" }, { enabled: true, configPath: "other" }, { enabled: false, headers: {} }])(
    "rejects invalid or privileged bodies before either write path", async (body) => {
      owner.localRuntimeBlocked.mockReturnValue(true);
      expect((await PATCH(request(body), context())).status).toBe(400);
      expect(owner.setMcpServerEnabledOnBackend).not.toHaveBeenCalled();
      expectNoLocalWork();
    });

  it.each(["%ZZ", "", "..", "a%2Fb", "a%5Cb"])("rejects invalid server names", async (name) => {
    expect((await PATCH(request({ enabled: true }), context(name))).status).toBe(400);
    expect(owner.setMcpServerEnabledOnBackend).not.toHaveBeenCalled();
    expectNoLocalWork();
  });
});
