import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ hostname: vi.fn(() => "server-host") }));
vi.mock("node:os", () => ({ hostname: mocks.hostname }));
import { GET, HEAD, OPTIONS } from "./route";
import { webUiPresentationResponse } from "@shared/webui-presentation.mjs";
import { createSecretCanaries, withCanaryEnvironment } from "../../../../scripts/spa-secret-canary.mjs";
const previous = process.env.LEAFCODE_PI_DATA_DIR;
afterEach(() => { mocks.hostname.mockReset().mockReturnValue("server-host"); if (previous === undefined) delete process.env.LEAFCODE_PI_DATA_DIR; else process.env.LEAFCODE_PI_DATA_DIR = previous; });

describe("public WebUI display bootstrap", () => {
  it("returns only the legacy hostname and auth-file display text, never request authority", async () => {
    process.env.LEAFCODE_PI_DATA_DIR = "/fixture <not-html>";
    const response = GET();
    expect(await response.json()).toEqual({ hostname: "server-host", authFileDisplayPath: `/fixture <not-html>${process.platform === "win32" ? "\\" : "/"}webui-auth.json` });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("keeps GET/HEAD metadata headers and explicit read-only method semantics", async () => {
    expect(HEAD().status).toBe(200); expect(await HEAD().text()).toBe("");
    expect(HEAD().headers.get("content-type")).toBe(GET().headers.get("content-type"));
    expect(OPTIONS().status).toBe(204); expect(OPTIONS().headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(webUiPresentationResponse("POST").status).toBe(405);
  });
  it("does not expose any owner/provider/environment credential canary", async () => {
    const canaries = createSecretCanaries();
    await withCanaryEnvironment(canaries, async () => {
      const body = await GET().text();
      for (const entry of canaries.entries) expect(body.includes(entry.value)).toBe(false);
      expect(Object.keys(JSON.parse(body)).sort()).toEqual(["authFileDisplayPath", "hostname"]);
    });
  });
  it("redacts server failures including their private exception text", async () => {
    mocks.hostname.mockImplementation(() => { throw Error("private dummy diagnostic"); });
    expect(GET().status).toBe(503);
    expect(await GET().json()).toEqual({ error: "WebUI display information unavailable" });
    expect(await HEAD().text()).toBe(""); expect(HEAD().status).toBe(503);
  });
});
