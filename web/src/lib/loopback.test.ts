import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./loopback";

describe("isLoopbackHost", () => {
  it("accepts localhost and the common loopback addresses", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("treats the whole 127.0.0.0/8 range as loopback", () => {
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("127.255.255.255")).toBe(true);
  });

  it("rejects other hosts and malformed input", () => {
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackHost("127.0.0")).toBe(false);
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(isLoopbackHost("  LOCALHOST ")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });
});