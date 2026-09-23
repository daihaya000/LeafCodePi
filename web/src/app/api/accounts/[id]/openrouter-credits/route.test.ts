import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, it, vi } from "vitest";
import { __resetPiAgentDirCacheForTests, accountAuthPath, createAccount, getAccount } from "@/lib/accounts";
import {
  createOpenRouterProvider,
  readOpenRouterCreditBaseline,
  readOpenRouterManagementKey,
} from "@/lib/codexbar/providers/openrouter";
import { DELETE as deleteBaseline, POST as saveBaseline } from "../openrouter-baseline/route";
import { GET as getAuthStatus } from "../auth-status/route";
import { DELETE as deleteAccountRoute } from "../route";
import { DELETE as deleteKey, POST as saveKey } from "./route";

const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

const dirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalManagementKey = process.env.OPENROUTER_MANAGEMENT_KEY;

afterEach(() => {
  undiciFetch.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.LEAFCODE_PI_DATA_DIR;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalManagementKey === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
  else process.env.OPENROUTER_MANAGEMENT_KEY = originalManagementKey;
  __resetPiAgentDirCacheForTests();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-openrouter-account-"));
  dirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  __resetPiAgentDirCacheForTests();
  return createAccount({ label: "OpenRouter", providers: ["openrouter"] });
}

function request(accountId: string, route: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/accounts/${accountId}/${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("account-scoped OpenRouter credits", () => {
  it("stores the management key without disclosing it, and derives display-only percent from the baseline", async () => {
    const account = setup();
    const authPath = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);
    const keyResponse = await saveKey(request(account.id, "openrouter-credits", "POST", { managementKey: "sk-management" }), context(account.id));
    assert.deepEqual(await keyResponse.json(), { ok: true, configured: true });
    assert.equal(readOpenRouterManagementKey(authPath), "sk-management");
    if (process.platform !== "win32") {
      const file = join(dirname(authPath), "openrouter.json");
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(authPath)).mode & 0o777, 0o700);
      chmodSync(file, 0o644); // 旧版の権限を読み取り時に移行する
      assert.equal(readOpenRouterManagementKey(authPath), "sk-management");
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    const baselineResponse = await saveBaseline(request(account.id, "openrouter-baseline", "POST", { baselineUsd: 50 }), context(account.id));
    assert.equal(baselineResponse.status, 200);
    assert.equal(readOpenRouterCreditBaseline(authPath), 50);

    const status = await getAuthStatus(request(account.id, "auth-status", "GET"), context(account.id));
    const statusText = await status.text();
    assert.equal(statusText.includes("sk-management"), false);
    assert.deepEqual(JSON.parse(statusText).openrouterManagementKeyConfigured, true);
    assert.deepEqual(JSON.parse(statusText).openrouterCreditBaseline, 50);

    undiciFetch.mockImplementation(async () => new Response(
      JSON.stringify({ data: { total_credits: 100, total_usage: 80 } }), { status: 200 },
    ));
    const provider = createOpenRouterProvider({
      key: `account:${account.id}`, kind: "account", accountId: account.id,
      accountLabel: account.label, authPath,
    });
    assert.equal(provider.isConfigured(), true);
    const snap = await provider.fetch();
    assert.equal(snap.creditsBalance, 20);
    assert.equal(snap.creditsUsed, 30);
    assert.equal(snap.creditsLimit, 50);
    assert.equal(snap.usageDisplayOnly, true);
    assert.equal(undiciFetch.mock.calls[0][0], "https://openrouter.ai/api/v1/credits");
    assert.equal((undiciFetch.mock.calls[0][1].headers as Record<string, string>).Authorization, "Bearer sk-management");

    await deleteBaseline(request(account.id, "openrouter-baseline", "DELETE"), context(account.id));
    const noBaseline = await provider.fetch();
    assert.equal(noBaseline.creditsBalance, 20);
    assert.equal(noBaseline.creditsUsed, null);
    assert.equal(noBaseline.creditsLimit, null);
    assert.equal(readOpenRouterManagementKey(authPath), "sk-management");

    await deleteKey(request(account.id, "openrouter-credits", "DELETE"), context(account.id));
    assert.equal(readOpenRouterManagementKey(authPath), null);
    assert.equal(provider.isConfigured(), false);
  });

  it("blocks account deletion until its management key is removed", async () => {
    const account = setup();
    await saveKey(request(account.id, "openrouter-credits", "POST", { managementKey: "sk-management" }), context(account.id));
    const blocked = await deleteAccountRoute(request(account.id, "", "DELETE"), context(account.id));
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /管理キーを先に削除/);
    assert.ok(getAccount(account.id));

    writeFileSync(join(dirname(accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!)), "openrouter.json"), "{", "utf8");
    const unreadable = await deleteAccountRoute(request(account.id, "", "DELETE"), context(account.id));
    assert.equal(unreadable.status, 500);
    assert.ok(getAccount(account.id));
    await saveKey(request(account.id, "openrouter-credits", "POST", { managementKey: "sk-management" }), context(account.id));
    await deleteKey(request(account.id, "openrouter-credits", "DELETE"), context(account.id));
    const removed = await deleteAccountRoute(request(account.id, "", "DELETE"), context(account.id));
    assert.equal(removed.status, 200);
    assert.equal(getAccount(account.id), undefined);
  });

  it("rejects invalid values and accounts without OpenRouter", async () => {
    const account = setup();
    const other = createAccount({ label: "Claude", providers: ["anthropic"] });
    for (const managementKey of ["", "a\nb", "x".repeat(4097), 42]) {
      const res = await saveKey(request(account.id, "openrouter-credits", "POST", { managementKey }), context(account.id));
      assert.equal(res.status, 400);
    }
    for (const baselineUsd of [0, -1, 1_000_001, "10", true, null]) {
      const res = await saveBaseline(request(account.id, "openrouter-baseline", "POST", { baselineUsd }), context(account.id));
      assert.equal(res.status, 400);
    }
    assert.equal((await saveKey(request(other.id, "openrouter-credits", "POST", { managementKey: "x" }), context(other.id))).status, 400);
    assert.equal((await saveBaseline(request("missing", "openrouter-baseline", "POST", { baselineUsd: 10 }), context("missing"))).status, 404);
  });
});
