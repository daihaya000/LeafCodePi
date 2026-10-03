// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPrivateHost,
  maybeRedirectToLocalhost,
} from "./localhost-redirect";

function stubLocation(hostname: string, href: string, port = "3000") {
  const replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { hostname, href, port, replace },
  });
  return replace;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPrivateHost", () => {
  it("accepts RFC 1918 private IPv4 ranges", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
  });

  it("accepts CGNAT and link-local ranges", () => {
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("100.127.255.255")).toBe(true);
    expect(isPrivateHost("100.128.0.1")).toBe(false);
    expect(isPrivateHost("169.254.1.1")).toBe(true);
  });

  it("accepts loopback via isLoopbackHost", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.0.0.2")).toBe(true);
    expect(isPrivateHost("localhost")).toBe(true);
  });

  it("accepts IPv6 unique-local addresses only", () => {
    expect(isPrivateHost("fc00::1")).toBe(true);
    expect(isPrivateHost("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateHost("[fd12:3456:789a::1]")).toBe(true);
    // fc/fd で始まるだけの公開ホスト名は IPv6 アドレスではない
    expect(isPrivateHost("fcloud.com")).toBe(false);
    expect(isPrivateHost("fdm.example.com")).toBe(false);
  });

  it("rejects public hosts and malformed input", () => {
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateHost("")).toBe(false);
    expect(isPrivateHost("   ")).toBe(false);
  });

  it("normalizes case and whitespace", () => {
    expect(isPrivateHost("  FCLOUD.COM ")).toBe(false);
    expect(isPrivateHost("  FD00::1 ")).toBe(true);
  });
});

describe("maybeRedirectToLocalhost", () => {
  it("skips loopback hosts entirely", async () => {
    const replace = stubLocation("127.0.0.1", "http://127.0.0.1:3000/");
    expect(await maybeRedirectToLocalhost()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("skips public hosts without probing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const replace = stubLocation("example.com", "http://example.com:3000/");
    expect(await maybeRedirectToLocalhost()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("stays put when the loopback probe fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const replace = stubLocation(
      "100.64.0.10",
      "http://100.64.0.10:3000/task/abc",
      "3000",
    );
    expect(await maybeRedirectToLocalhost()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("stays put when another WebUI answers on the client's own loopback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json({ id: url.startsWith("http://127.0.0.1") ? "client-pc" : "host-pc" }),
      ),
    );
    const replace = stubLocation("100.64.0.10", "http://100.64.0.10:3000/", "3000");
    expect(await maybeRedirectToLocalhost()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("stays put when an unrelated service answers without a probe id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("http://127.0.0.1")
          ? new Response("<html></html>", { status: 200 })
          : Response.json({ id: "host-pc" }),
      ),
    );
    const replace = stubLocation("100.64.0.10", "http://100.64.0.10:3000/", "3000");
    expect(await maybeRedirectToLocalhost()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects to 127.0.0.1 once the loopback WebUI is the same process", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "host-pc" })));
    const replace = stubLocation(
      "100.64.0.10",
      "http://100.64.0.10:3000/task/abc",
      "3000",
    );
    expect(await maybeRedirectToLocalhost()).toBe(
      "http://127.0.0.1:3000/task/abc",
    );
    expect(replace).toHaveBeenCalledWith("http://127.0.0.1:3000/task/abc");
  });

  it("handles bare IPv6 hostnames and probes the canonical loopback URL", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return Response.json({ id: "host-pc" });
      }),
    );
    stubLocation("fd12:3456:789a::1", "http://[fd12:3456:789a::1]:3000/task", "3000");

    expect(await maybeRedirectToLocalhost()).toBe("http://127.0.0.1:3000/task");
    expect(urls).toEqual([
      "/api/host-probe",
      "http://127.0.0.1:3000/api/host-probe",
    ]);
  });

  it("probes default HTTP/HTTPS ports without an empty port delimiter", async () => {
    for (const [href, loopbackOrigin] of [
      ["http://100.64.0.10/task", "http://127.0.0.1"],
      ["https://100.64.0.10/task", "https://127.0.0.1"],
    ]) {
      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          urls.push(url);
          return Response.json({ id: "host-pc" });
        }),
      );
      stubLocation("100.64.0.10", href, "");

      expect(await maybeRedirectToLocalhost()).toBe(`${loopbackOrigin}/task`);
      expect(urls).toEqual([
        "/api/host-probe",
        `${loopbackOrigin}/api/host-probe`,
      ]);
    }
  });
});
