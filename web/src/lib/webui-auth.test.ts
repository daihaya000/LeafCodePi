import { describe, expect, it } from "vitest";
import { isPublicWebUiPath, tokensMatch, webUiAuthRequired } from "./webui-auth-shared";

describe("webUiAuthRequired", () => {
  it("is false without env", () => {
    expect(webUiAuthRequired()).toBe(false);
  });
});

describe("tokensMatch", () => {
  it("accepts equal tokens", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
  });

  it("rejects different tokens", () => {
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("", "abc")).toBe(false);
  });
});

describe("isPublicWebUiPath", () => {
  it("allows login and health", () => {
    expect(isPublicWebUiPath("/login")).toBe(true);
    expect(isPublicWebUiPath("/api/health")).toBe(true);
    expect(isPublicWebUiPath("/api/auth/webui")).toBe(true);
    expect(isPublicWebUiPath("/")).toBe(false);
  });
});
