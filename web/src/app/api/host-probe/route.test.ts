import { describe, expect, it } from "vitest";
import { isPublicWebUiPath } from "@/lib/webui-auth-shared";
import { GET, OPTIONS } from "./route";

describe("/api/host-probe", () => {
  it("returns a stable per-process id with CORS headers", async () => {
    const a = await GET().json();
    const b = await GET().json();
    expect(typeof a.id).toBe("string");
    expect(a.id).toBe(b.id);
    expect(Object.keys(a)).toEqual(["id"]);
    expect(GET().headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers the Private Network Access preflight", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("is reachable without WebUI auth", () => {
    expect(isPublicWebUiPath("/api/host-probe")).toBe(true);
  });
});
