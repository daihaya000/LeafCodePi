import { BackendTestRequest as Request } from "@/test-request";
import { describe, expect, it } from "vitest";
import { isCrossOriginRequest } from "./same-origin";

const req = (headers: Record<string, string>, url = "http://100.127.32.3:3000/api/x") =>
  new Request(url, { method: "PUT", headers });

describe("isCrossOriginRequest", () => {
  it("allows requests without Origin or with the identical origin", () => {
    expect(isCrossOriginRequest(req({}))).toBe(false);
    expect(isCrossOriginRequest(req({ origin: "http://100.127.32.3:3000" }))).toBe(false);
  });

  it("allows an Origin matching the Host header even when the server URL reflects the bind address", () => {
    const r = req({ origin: "http://pc.tailnet.ts.net:3000", host: "pc.tailnet.ts.net:3000" }, "http://0.0.0.0:3000/api/x");
    expect(isCrossOriginRequest(r)).toBe(false);
  });

  it("allows https Origin behind a TLS-terminating proxy via X-Forwarded-Host", () => {
    const r = req({ origin: "https://pc.tailnet.ts.net", host: "127.0.0.1:3000", "x-forwarded-host": "pc.tailnet.ts.net" });
    expect(isCrossOriginRequest(r)).toBe(false);
  });

  it("rejects foreign, opaque and cross-site requests", () => {
    expect(isCrossOriginRequest(req({ origin: "https://other.example", host: "100.127.32.3:3000" }))).toBe(true);
    expect(isCrossOriginRequest(req({ origin: "null" }))).toBe(true);
    expect(isCrossOriginRequest(req({ origin: "http://100.127.32.3:3000", "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossOriginRequest(req({ origin: "http://100.127.32.3:4000", host: "100.127.32.3:3000" }))).toBe(true);
  });
});
