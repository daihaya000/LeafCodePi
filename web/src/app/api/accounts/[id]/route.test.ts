import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePeerConfig } from "@backend-core/peer-auth-config.mjs";
import { __resetPiAgentDirCacheForTests, accountAuthPath, accountDir, createAccount, getAccount } from "@/lib/accounts";

vi.mock("@/lib/pi/harness", () => ({
  invalidateHealthCache: vi.fn(),
  jsonError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: (error as { status?: number }).status ?? 500,
  }),
}));

import { DELETE, PATCH } from "./route";

let root: string;
const agentDir = () => join(root, "agent");
const request = () => new NextRequest("http://lcp.test/api/accounts/x", { method: "DELETE" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-pi-account-delete-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir());
  __resetPiAgentDirCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetPiAgentDirCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("DELETE /api/accounts/[id]", () => {
  it("removes peer.json (the peer token) together with a peer account, keeping the rest of the auth directory", async () => {
    const account = createAccount({ label: "peer", providers: ["anthropic"] });
    const dir = accountDir(account.id, agentDir());
    writePeerConfig(dir, { peerUrl: "http://100.64.0.2:3000", peerAccountId: null, providers: ["anthropic"], token: "p".repeat(43) });
    writeFileSync(join(dir, "models-store.json"), "{}", "utf8");

    const response = await DELETE(request(), { params: Promise.resolve({ id: account.id }) });
    expect(response.status).toBe(200);
    expect(getAccount(account.id)).toBeUndefined();
    expect(existsSync(join(dir, "peer.json"))).toBe(false);
    expect(existsSync(join(dir, "models-store.json"))).toBe(true);
  });

  it("deletes an ordinary account without touching its auth.json", async () => {
    const account = createAccount({ label: "local", providers: ["anthropic"] });
    const authPath = accountAuthPath(account.id, agentDir());
    mkdirSync(accountDir(account.id, agentDir()), { recursive: true });
    writeFileSync(authPath, "{}", "utf8");

    const response = await DELETE(request(), { params: Promise.resolve({ id: account.id }) });
    expect(response.status).toBe(200);
    expect(existsSync(authPath)).toBe(true);
  });
});

describe("PATCH per-account Codex automatic resets", () => {
  it("saves OFF/ON without changing another account or account enablement", async () => {
    const a = createAccount({ label: "A", providers: ["openai-codex"], note: "keep" });
    const b = createAccount({ label: "B", providers: ["openai-codex"] });
    for (const enabled of [false, true]) {
      const req = new NextRequest("http://lcp.test/api/accounts/" + a.id, {
        method: "PATCH", body: JSON.stringify({ codexResetAutoConsume: enabled }),
      });
      const result = await PATCH(req, { params: Promise.resolve({ id: a.id }) });
      expect(result.status).toBe(200);
      expect((await result.json()).account.codexResetAutoConsume).toBe(enabled);
      expect(getAccount(a.id)).toMatchObject({ enabled: true, note: "keep", codexResetAutoConsume: enabled });
      expect(getAccount(b.id)?.codexResetAutoConsume).toBeUndefined();
    }
  });
  it.each(["false", null, 0])("rejects invalid flags %j without updating the account", async (flag) => {
    const a = createAccount({ label: "A", providers: ["openai-codex"] });
    const req = new NextRequest("http://lcp.test/api/accounts/" + a.id, {
      method: "PATCH", body: JSON.stringify({ codexResetAutoConsume: flag }),
    });
    expect((await PATCH(req, { params: Promise.resolve({ id: a.id }) })).status).toBe(400);
    expect(getAccount(a.id)?.codexResetAutoConsume).toBeUndefined();
  });
  it("refuses the preference for a non-Codex account", async () => {
    const a = createAccount({ label: "Claude", providers: ["anthropic"] });
    const req = new NextRequest("http://lcp.test/api/accounts/" + a.id, {
      method: "PATCH", body: JSON.stringify({ codexResetAutoConsume: false }),
    });
    expect((await PATCH(req, { params: Promise.resolve({ id: a.id }) })).status).toBe(400);
    expect(getAccount(a.id)?.codexResetAutoConsume).toBeUndefined();
  });
});
