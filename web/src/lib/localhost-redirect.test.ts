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

  it("redirects to 127.0.0.1 once the loopback WebUI answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
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
});