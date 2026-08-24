import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicWebUiPath, tokensMatch, webUiAuthRequired } from "./webui-auth-shared";

describe("webUiAuthRequired", () => {
  // 実行環境（サーバー起動シェル）から LEAFCODE_PI_WEBUI_* が漏れても影響しないよう固定する
  afterEach(() => vi.unstubAllEnvs());

  it("is false without env", () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "");
    expect(webUiAuthRequired()).toBe(false);
  });

  it("is true when auth is required with a token", () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "secret");
    expect(webUiAuthRequired()).toBe(true);
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
