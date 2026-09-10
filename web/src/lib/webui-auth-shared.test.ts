import { describe, expect, it } from "vitest";
import {
  expectedWebUiToken,
  isPublicWebUiPath,
  tokensMatch,
  webUiAuthRequired,
} from "./webui-auth-shared";

describe("tokensMatch", () => {
  it("matches equal tokens", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
    expect(tokensMatch("", "")).toBe(false); // 空は常に不一致
  });

  it("rejects length mismatches immediately", () => {
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("abcd", "abc")).toBe(false);
    expect(tokensMatch("abc", "")).toBe(false);
    expect(tokensMatch("", "abc")).toBe(false);
  });

  it("rejects different tokens of the same length", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
    expect(tokensMatch("secret", "SECRET")).toBe(false);
  });
});

describe("isPublicWebUiPath", () => {
  it("allows login, auth API, health, static assets and favicon", () => {
    expect(isPublicWebUiPath("/login")).toBe(true);
    expect(isPublicWebUiPath("/api/auth/webui/status")).toBe(true);
    expect(isPublicWebUiPath("/api/health")).toBe(true);
    expect(isPublicWebUiPath("/_next/static/chunks/app.js")).toBe(true);
    expect(isPublicWebUiPath("/favicon.ico")).toBe(true);
  });

  it("keeps everything else protected", () => {
    expect(isPublicWebUiPath("/")).toBe(false);
    expect(isPublicWebUiPath("/api/tasks")).toBe(false);
    expect(isPublicWebUiPath("/settings")).toBe(false);
    expect(isPublicWebUiPath("/apifake")).toBe(false);
  });
});

describe("webUiAuthRequired / expectedWebUiToken", () => {
  it("requires auth only with the explicit env flag", () => {
    const previous = process.env.LEAFCODE_PI_WEBUI_AUTH;
    process.env.LEAFCODE_PI_WEBUI_AUTH = "required";
    expect(webUiAuthRequired()).toBe(true);
    process.env.LEAFCODE_PI_WEBUI_AUTH = "optional";
    expect(webUiAuthRequired()).toBe(false);
    process.env.LEAFCODE_PI_WEBUI_AUTH = undefined;
    expect(webUiAuthRequired()).toBe(false);
    process.env.LEAFCODE_PI_WEBUI_AUTH = previous;
  });

  it("reads the expected token with surrounding whitespace stripped", () => {
    const previous = process.env.LEAFCODE_PI_WEBUI_TOKEN;
    process.env.LEAFCODE_PI_WEBUI_TOKEN = "  tok-123  ";
    expect(expectedWebUiToken()).toBe("tok-123");
    process.env.LEAFCODE_PI_WEBUI_TOKEN = previous;
  });
});