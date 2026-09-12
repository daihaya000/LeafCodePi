import { afterEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

import {
  autoConsumeExpiringResetCredits,
  consumeCodexResetCredit,
  describeResetConsumeCode,
  parseCodexResetConsumeJson,
  parseCodexResetCreditsJson,
  sortResetCreditsByExpiry,
} from "./openai-codex-reset";

afterEach(() => {
  undiciFetch.mockReset();
});

describe("parseCodexResetCreditsJson", () => {
  it("keeps available credits and sorts earliest expiry first", () => {
    const list = parseCodexResetCreditsJson(
      JSON.stringify({
        available_count: 2,
        credits: [
          {
            id: "RateLimitResetCredit_later",
            status: "available",
            expires_at: "2026-08-01T00:00:00Z",
            title: "Later",
          },
          {
            id: "RateLimitResetCredit_soon",
            status: "available",
            expires_at: "2026-07-01T00:00:00Z",
            title: "Soon",
          },
          {
            id: "RateLimitResetCredit_used",
            status: "redeemed",
            expires_at: "2026-06-01T00:00:00Z",
            title: "Used",
          },
        ],
      }),
    );
    expect(list.availableCount).toBe(2);
    expect(list.credits.map((c) => c.id)).toEqual([
      "RateLimitResetCredit_soon",
      "RateLimitResetCredit_later",
    ]);
  });

  it("falls back to available list length when available_count is missing", () => {
    const list = parseCodexResetCreditsJson(
      JSON.stringify({
        credits: [
          { id: "a", status: "available" },
          { id: "b", status: "redeemed" },
        ],
      }),
    );
    expect(list.availableCount).toBe(1);
    expect(list.credits).toHaveLength(1);
  });
});

describe("sortResetCreditsByExpiry", () => {
  it("puts missing expiry last", () => {
    const sorted = sortResetCreditsByExpiry([
      {
        id: "no-exp",
        resetType: null,
        status: "available",
        grantedAt: null,
        expiresAt: null,
        title: null,
        description: null,
      },
      {
        id: "has-exp",
        resetType: null,
        status: "available",
        grantedAt: null,
        expiresAt: "2026-07-01T00:00:00Z",
        title: null,
        description: null,
      },
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["has-exp", "no-exp"]);
  });
});

describe("parseCodexResetConsumeJson", () => {
  it("treats reset and already_redeemed as ok", () => {
    expect(
      parseCodexResetConsumeJson(
        JSON.stringify({
          code: "reset",
          windows_reset: 2,
          credit: { id: "c1" },
        }),
        200,
      ),
    ).toMatchObject({
      ok: true,
      code: "reset",
      windowsReset: 2,
      creditId: "c1",
    });

    expect(
      parseCodexResetConsumeJson(
        JSON.stringify({ code: "already_redeemed" }),
        200,
      ).ok,
    ).toBe(true);
  });

  it("keeps business failures as ok:false", () => {
    expect(
      parseCodexResetConsumeJson(JSON.stringify({ code: "nothing_to_reset" }), 200),
    ).toMatchObject({ ok: false, code: "nothing_to_reset" });
    expect(
      parseCodexResetConsumeJson(JSON.stringify({ code: "no_credit" }), 200),
    ).toMatchObject({ ok: false, code: "no_credit" });
  });
});

describe("describeResetConsumeCode", () => {
  it("maps known codes to Japanese messages", () => {
    expect(describeResetConsumeCode("reset")).toContain("リセットしました");
    expect(describeResetConsumeCode("no_credit")).toContain("ありません");
  });
});

describe("autoConsumeExpiringResetCredits", () => {
  it("redeems only credits expiring within the configured window", async () => {
    undiciFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available_count: 2,
            credits: [
              {
                id: "soon",
                status: "available",
                expires_at: "2026-07-01T12:00:00Z",
              },
              {
                id: "later",
                status: "available",
                expires_at: "2026-07-03T12:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "reset" }), { status: 200 }),
      );

    const result = await autoConsumeExpiringResetCredits(
      { accessToken: "tok", chatgptAccountId: null },
      {
        now: Date.parse("2026-07-01T00:00:00Z"),
        windowMs: 24 * 60 * 60 * 1000,
      },
    );

    expect(result).toEqual({ expiring: 1, consumed: 1, codes: ["reset"] });
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    const [, init] = undiciFetch.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      credit_id: "soon",
      redeem_request_id: "auto-soon",
    });
  });

  it("stops when there is no reset target", async () => {
    undiciFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            credits: [
              {
                id: "first",
                status: "available",
                expires_at: "2026-07-01T01:00:00Z",
              },
              {
                id: "second",
                status: "available",
                expires_at: "2026-07-01T02:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "nothing_to_reset" }), {
          status: 200,
        }),
      );

    const result = await autoConsumeExpiringResetCredits(
      { accessToken: "tok", chatgptAccountId: null },
      {
        now: Date.parse("2026-07-01T00:00:00Z"),
        windowMs: 24 * 60 * 60 * 1000,
      },
    );

    expect(result).toEqual({
      expiring: 2,
      consumed: 0,
      codes: ["nothing_to_reset"],
    });
    expect(undiciFetch).toHaveBeenCalledTimes(2);
  });
});

describe("consumeCodexResetCredit", () => {
  it("posts credit_id and redeem_request_id with account header", async () => {
    undiciFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "reset", windows_reset: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await consumeCodexResetCredit(
      { accessToken: "tok", chatgptAccountId: "acct" },
      { creditId: "RateLimitResetCredit_1", redeemRequestId: "req-1" },
    );

    expect(result.ok).toBe(true);
    expect(undiciFetch).toHaveBeenCalledOnce();
    const [url, init] = undiciFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      credit_id: "RateLimitResetCredit_1",
      redeem_request_id: "req-1",
      account_id: "acct",
    });
    expect((init.headers as Record<string, string>)["ChatGPT-Account-Id"]).toBe(
      "acct",
    );
  });
});
