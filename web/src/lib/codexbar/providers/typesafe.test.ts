import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPiAuthPath } from "@/lib/codexbar/pi-auth";
import { saveTypesafeCookieFile } from "@/lib/codexbar/browser-cookies";

const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

import {
  estimatedTypesafeUsd,
  extractTypesafeBillingActionId,
  parseTypesafeBillingActionResponse,
  readTypesafeUsageTotals,
  recordTypesafeUsage,
  resolveTypesafeApiKey,
  typesafeProvider,
  writeTypesafeCreditBaseline,
} from "./typesafe";

const previousAppData = process.env.APPDATA;
const previousLocalAppData = process.env.LOCALAPPDATA;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.LEAFCODE_PI_DATA_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  undiciFetch.mockReset();
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-typesafe-usage-"));
  dirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  return dir;
}

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-typesafe-agent-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

/** cookie ファイルの探索先（APPDATA\CodexBar）を隔離する。既定では未設定にする。 */
function isolateCookieConfigDir(): void {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-typesafe-cookiecfg-"));
  dirs.push(dir);
  process.env.APPDATA = dir;
  // Chromium fallback が実ブラウザのDPAPI cookie DBを走査しないよう隔離する。
  process.env.LOCALAPPDATA = dir;
}

describe("typesafe usage totals", () => {
  it("starts empty and accumulates across calls", () => {
    tempDataDir();
    expect(readTypesafeUsageTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      updatedAt: null,
    });

    recordTypesafeUsage({ input_tokens: 100, output_tokens: 20 });
    recordTypesafeUsage({ input_tokens: 50, output_tokens: 5 });

    const totals = readTypesafeUsageTotals();
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(25);
    expect(totals.calls).toBe(2);
    expect(totals.updatedAt).not.toBeNull();
  });

  it("estimates USD from the published $42/Btok input price (output free)", () => {
    expect(
      estimatedTypesafeUsd({
        inputTokens: 1_000_000_000,
        outputTokens: 0,
        calls: 1,
        updatedAt: null,
      }),
    ).toBe(42);
    expect(
      estimatedTypesafeUsd({
        inputTokens: 0,
        outputTokens: 999,
        calls: 1,
        updatedAt: null,
      }),
    ).toBe(0);
  });

  it("never throws when the counter file is corrupt", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "typesafe-usage.json"), "{not json", "utf8");
    expect(readTypesafeUsageTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      updatedAt: null,
    });
    expect(() => recordTypesafeUsage({ input_tokens: 1 })).not.toThrow();
  });
});

describe("parseTypesafeBillingActionResponse", () => {
  // 実際の console.typesafe.ai レスポンス（RSC flight 行形式）の抜粋。
  const realisticBody =
    '2:"$Sreact.fragment"\n' +
    ':HL["/_next/static/chunks/2lh-xl026qalb.css?dpl=x","style",{}]\n' +
    '9:X\n' +
    '0:{"a":"$@1","f":[["","..."]]}\n' +
    '1:{"ok":true,"data":{"billing":{"plan":"free_plan","spent":0.01,"freeCreditsRemaining":4.98,"balance":4.98,"purchased":0,"resetsInDays":14,"cycleLabel":"September 2026","paymentMethod":null,"autoPay":null,"credits":[{"id":"c1","amount":5,"remaining":4.98,"createdAt":"2026-09-16T00:00:00Z","expiresAt":"2026-10-16T00:00:00Z","reason":"free_tier_credit"}]},"payments":[],"hasMore":false,"credits":"$1:data:billing:credits"}}\n';

  it("finds the data line among RSC flight noise and extracts billing fields", () => {
    const billing = parseTypesafeBillingActionResponse(realisticBody);
    expect(billing).toEqual({
      plan: "free_plan",
      spent: 0.01,
      freeCreditsRemaining: 4.98,
      purchased: 0,
      balance: 4.98,
      resetsInDays: 14,
      cycleLabel: "September 2026",
    });
  });

  it("throws when no line contains billing data", () => {
    expect(() => parseTypesafeBillingActionResponse('0:{"a":1}\n')).toThrow();
  });

  it("extracts the nearest action ID from a server reference", () => {
    const otherActionId = "c".repeat(42);
    const actionId = "a".repeat(42);
    expect(
      extractTypesafeBillingActionId(
        `createServerReference("${otherActionId}",callServer,void 0,findSourceMapURL,"otherAction") createServerReference("${actionId}",callServer,void 0,findSourceMapURL,"getBillingOverviewResult")`,
      ),
    ).toBe(actionId);
  });
});

describe("resolveTypesafeApiKey / typesafeProvider", () => {
  it("is unconfigured without a stored api_key entry or console cookie", () => {
    tempAgentDir();
    isolateCookieConfigDir();
    expect(resolveTypesafeApiKey()).toBeNull();
    expect(typesafeProvider.isConfigured()).toBe(false);
  });

  it("is configured once auth.json has a typesafe api_key entry", () => {
    tempAgentDir();
    isolateCookieConfigDir();
    writeFileSync(
      defaultPiAuthPath(),
      JSON.stringify({ typesafe: { type: "api_key", key: "sk-test" } }),
      "utf8",
    );
    expect(resolveTypesafeApiKey()).toBe("sk-test");
    expect(typesafeProvider.isConfigured()).toBe(true);
  });

  it("is configured from a console cookie file alone (no api key needed)", () => {
    tempAgentDir();
    isolateCookieConfigDir();
    saveTypesafeCookieFile(
      "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n" +
        "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg_1\n",
    );
    expect(typesafeProvider.isConfigured()).toBe(true);
  });

  it("fetch() falls back to the local estimate snapshot without a cookie", async () => {
    tempDataDir();
    isolateCookieConfigDir();
    recordTypesafeUsage({ input_tokens: 1_000_000_000, output_tokens: 1 });

    const snapshot = await typesafeProvider.fetch();
    expect(snapshot.providerId).toBe("typesafe");
    expect(snapshot.creditsEnabled).toBe(true);
    expect(snapshot.creditsUsed).toBe(42);
    expect(snapshot.creditsLimit).toBeNull();
    expect(snapshot.creditsBalance).toBeNull();
    expect(snapshot.usageDisplayOnly).toBe(true);
    expect(snapshot.windows).toEqual([]);
  });

  it("fetch() reports the real balance when a console cookie authenticates", async () => {
    tempDataDir();
    isolateCookieConfigDir();
    saveTypesafeCookieFile(
      "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n" +
        "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg_1\n" +
        "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession\tjwt-token\n",
    );
    undiciFetch.mockResolvedValueOnce(
      new Response(
        '1:{"ok":true,"data":{"billing":{"plan":"free_plan","spent":0.01,"freeCreditsRemaining":4.98,"balance":4.98,"purchased":0,"resetsInDays":14,"cycleLabel":"September 2026"}}}\n',
        { status: 200 },
      ),
    );

    const snapshot = await typesafeProvider.fetch();
    expect(snapshot.plan).toBe("Free");
    expect(snapshot.creditsUsed).toBe(0.01);
    expect(snapshot.creditsBalance).toBe(4.98);
    expect(snapshot.usageDisplayOnly).toBeUndefined();
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://console.typesafe.ai/settings/billing",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Next-Action": "00216a0f6524a89c66b80e4babe337d5f2d86e071b",
          Cookie: expect.stringContaining("session_id=tok"),
        }),
      }),
    );
    expect(
      (undiciFetch.mock.calls[0]?.[1] as RequestInit).headers,
    ).toEqual(expect.objectContaining({ Cookie: expect.stringContaining("session=jwt-token") }));
  });

  it("fetch() derives a display-only percentage from the saved baseline", async () => {
    tempDataDir();
    isolateCookieConfigDir();
    saveTypesafeCookieFile(
      "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n" +
        "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg_1\n",
    );
    writeTypesafeCreditBaseline(5);
    undiciFetch.mockResolvedValueOnce(
      new Response(
        '1:{"ok":true,"data":{"billing":{"plan":"free_plan","spent":0.01,"freeCreditsRemaining":4.98,"balance":4.98,"purchased":0,"resetsInDays":14,"cycleLabel":"September 2026"}}}\n',
        { status: 200 },
      ),
    );

    const snapshot = await typesafeProvider.fetch();
    expect(snapshot.creditsUsed).toBeCloseTo(0.02);
    expect(snapshot.creditsLimit).toBe(5);
    expect(snapshot.creditsBalance).toBe(4.98);
    expect(snapshot.usageDisplayOnly).toBe(true);
  });

  it("fetch() falls back to the local estimate when the cookie session is stale", async () => {
    tempDataDir();
    isolateCookieConfigDir();
    saveTypesafeCookieFile(
      "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n" +
        "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg_1\n",
    );
    undiciFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const snapshot = await typesafeProvider.fetch();
    expect(snapshot.usageDisplayOnly).toBe(true);
    expect(snapshot.creditsBalance).toBeNull();
  });

  it("rediscovers the billing action after a deployment changes its ID", async () => {
    tempDataDir();
    isolateCookieConfigDir();
    saveTypesafeCookieFile(
      "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n" +
        "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg_1\n",
    );
    const actionId = "b".repeat(42);
    undiciFetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          '<html><script src="/_next/static/chunks/billing.js"></script></html>',
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `createServerReference("${actionId}",callServer,void 0,findSourceMapURL,"getBillingOverviewResult")`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          '1:{"ok":true,"data":{"billing":{"plan":"free_plan","spent":0.02,"balance":4.97}}}\n',
          { status: 200 },
        ),
      );

    const snapshot = await typesafeProvider.fetch();
    expect(snapshot.plan).toBe("Free");
    expect(snapshot.creditsUsed).toBe(0.02);
    expect(undiciFetch.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ headers: { Accept: "*/*" } }),
    );
    expect(undiciFetch.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "Next-Action": actionId }),
      }),
    );
  });
});
