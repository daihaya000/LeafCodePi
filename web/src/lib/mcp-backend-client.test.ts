import { describe, expect, it, vi } from "vitest";
import { setMcpServerEnabledOnBackend } from "./backend-client";
const env = { LEAFCODE_PI_BACKEND_TOKEN: "t".repeat(40), LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:19999" };
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
describe("MCP Backend ON/OFF client", () => {
  it("encodes one server segment and sends only enabled with private authentication", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { ok: true, name: "server name", enabled: false, servers: [] }));
    const result = await setMcpServerEnabledOnBackend("server name", false, { env, fetchImpl });
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:19999/internal/mcp/servers/server%20name");
    const options = fetchImpl.mock.calls[0][1]!;
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body as string)).toEqual({ enabled: false });
    expect(options.headers).toMatchObject({ authorization: `Bearer ${env.LEAFCODE_PI_BACKEND_TOKEN}`, "x-leafcode-backend-protocol": "1" });
  });
  it("makes no request without Backend credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await setMcpServerEnabledOnBackend("server", true, { env: {}, fetchImpl })).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([404, 409, 503])("preserves an owner refusal %i without disclosing raw errors", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(status, { error: "private-fixture-token", code: "BACKEND_BAD_REQUEST" }));
    const result = await setMcpServerEnabledOnBackend("server", true, { env, fetchImpl });
    expect(result).toEqual({ ok: false, reason: "bad-response", status });
  });
});
