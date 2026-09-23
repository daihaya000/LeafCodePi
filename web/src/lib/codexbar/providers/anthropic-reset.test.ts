import { describe, expect, it } from "vitest";
import {
  claudeWebCookieHeader,
  claudeWebOrgId,
  parseClaudeResetConsumeJson,
  parseClaudeResetGrants,
} from "./anthropic-reset";

const grant = (over: Record<string, unknown> = {}) => ({
  id: "g1",
  label: "Limit reset",
  resets_total: 1,
  resets_left: 1,
  ends_at: "2026-10-22T00:00:00Z",
  clears: ["five_hour", "seven_day"],
  usable_now: true,
  use_requires_limit: false,
  blocking: [],
  ...over,
});

describe("parseClaudeResetGrants", () => {
  it("marks next_grant_id usable when it does not require a limit", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      at_limit: false,
      grants: [grant({ id: "later" }), grant()],
      next_grant_id: "g1",
      cooldown_until: null,
    });
    expect(r.nextGrantId).toBe("g1");
    expect(r.availableCount).toBe(2);
    expect(r.credits[0]).toMatchObject({ id: "g1", status: "available", expiresAt: "2026-10-22T00:00:00Z" });
    expect(r.credits[1]?.status).toBe("unavailable");
  });

  it("requires an exhausted cleared window when use_requires_limit", () => {
    const block = {
      eligible: true,
      at_limit: false,
      exhausted: ["five_hour"],
      grants: [grant({ use_requires_limit: true })],
      next_grant_id: "g1",
    };
    expect(parseClaudeResetGrants(block).nextGrantId).toBeNull();
    expect(parseClaudeResetGrants({ ...block, at_limit: true }).nextGrantId).toBe("g1");
  });

  it("blocks during cooldown and ignores paused grants in the count", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      grants: [grant(), grant({ id: "p", paused: true })],
      next_grant_id: "g1",
      cooldown_until: "2026-09-24T00:00:00Z",
    });
    expect(r.nextGrantId).toBeNull();
    expect(r.availableCount).toBe(1);
  });

  it("returns empty for OAuth surface ineligibility", () => {
    const r = parseClaudeResetGrants({ eligible: false, ineligible_reason: "surface", grants: [] });
    expect(r).toMatchObject({ availableCount: 0, eligible: false, ineligibleReason: "surface" });
    expect(parseClaudeResetGrants(null).availableCount).toBe(0);
  });
});

describe("parseClaudeResetConsumeJson", () => {
  it("treats only reset as success", () => {
    expect(parseClaudeResetConsumeJson('{"result":"reset","grant_id":"g1","resets_left":0}')).toEqual({
      ok: true,
      code: "reset",
      grantId: "g1",
      resetsLeft: 0,
    });
    expect(parseClaudeResetConsumeJson('{"result":"already_used"}').ok).toBe(false);
    expect(parseClaudeResetConsumeJson("oops").code).toBe("invalid_response");
  });
});

describe("claude.ai cookie selection", () => {
  const c = (name: string, domain: string, value = "v") => ({
    name,
    value,
    domain,
    hostOnly: false,
    path: "/",
    secure: true,
    expiresAt: null,
  });

  it("uses claude.ai sessionKey/org, not the Console ones", () => {
    const consoleOnly = {
      sourceLabel: "t",
      cookies: [c("sessionKey", "platform.claude.com"), c("lastActiveOrg", "claude.com", "console-org")],
    };
    expect(claudeWebCookieHeader(consoleOnly)).toBeNull();
    expect(claudeWebOrgId(consoleOnly)).toBeNull();

    const web = { sourceLabel: "t", cookies: [...consoleOnly.cookies, c("sessionKey", "claude.ai"), c("lastActiveOrg", "claude.ai", "web-org")] };
    expect(claudeWebCookieHeader(web)).toContain("sessionKey=v");
    expect(claudeWebOrgId(web)).toBe("web-org");
  });
});
