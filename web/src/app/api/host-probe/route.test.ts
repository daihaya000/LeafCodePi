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
  });

  it("allows CORS reads only from private-network origins", () => {
    const req = (origin: string) => new Request("http://127.0.0.1:3000/api/host-probe", { headers: { origin } });
    expect(GET(req("http://100.101.102.103:3000")).headers.get("access-control-allow-origin")).toBe("http://100.101.102.103:3000");
    expect(GET(req("http://192.168.1.5:3000")).headers.get("access-control-allow-origin")).toBe("http://192.168.1.5:3000");
    expect(GET(req("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    expect(GET(req("null")).headers.get("access-control-allow-origin")).toBeNull();
    expect(GET().headers.get("access-control-allow-origin")).toBeNull();
    expect(OPTIONS(req("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
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
