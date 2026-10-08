import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { __resetPiAgentDirCacheForTests, createAccount, listAccounts } from "@/lib/accounts";
import { peerAuthService } from "@/lib/peer-auth/runtime";
import { importPeerAccount, listPeerAccounts } from "@/lib/peer-auth/import";
import { createPeerGrantStore } from "@backend-core/peer-auth-grants.mjs";
import { writePeerConfig, removePeerConfig } from "@backend-core/peer-auth-config.mjs";
const mocks = vi.hoisted(() => ({ getProviderAuthForPeer: vi.fn(), list: vi.fn(), listAccounts: vi.fn() }));
vi.mock("@/lib/pi/harness", async original => ({ ...(await original<object>()), getRuntimeFor: async (accountId: string) => ({ getAuth: (providerId: string, options: unknown) => mocks.getProviderAuthForPeer(providerId, accountId, options) }) }));
vi.mock("@backend-core/peer-auth-remote-store.mjs", async original => ({ ...(await original<object>()), createRemotePeerCredentialStore: () => ({ list: mocks.list, listAccounts: mocks.listAccounts }) }));
let root: string;
const serviceKey = Symbol.for("leafcode-pi.peer-auth-service");
function resetService() { delete (globalThis as Record<symbol, unknown>)[serviceKey]; }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-peer-owner-"));
  for (const [key, value] of Object.entries({ LEAFCODE_PI_DATA_DIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_WEBUI_AUTH: "required", LEAFCODE_PI_WEBUI_TOKEN: "UI-PRIVATE" })) vi.stubEnv(key, value);
  resetService(); __resetPiAgentDirCacheForTests(); for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue([{ providerId: "anthropic", type: "api_key" }]); mocks.listAccounts.mockResolvedValue([{ accountId: "remote", label: "Source", providers: ["anthropic"] }]);
});
afterEach(() => { resetService(); __resetPiAgentDirCacheForTests(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function request(route: string, method: string, body?: unknown, authorized = true, bearer?: string, operationId = randomUUID(), query = "") {
  const result = await dispatchJsonBusinessRequest({ route, method, operationId, authorized, url: `http://localhost/api/${route}${query}`, headers: { host: "localhost", ...(bearer ? { authorization: bearer } : {}) }, ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }) });
  const projected = publicJsonBusinessResult(route, result); expect(projected).not.toBeNull(); return projected!;
}
async function grant() {
  const created = await request("peer-auth/peers", "POST", { label: "Peer fixture", providers: ["anthropic"] }); expect(created.status).toBe(201); expect(created.body).toMatchObject({ mutation: { saved: true, saveStatus: "complete" } });
  expect((await request("peer-auth/peers", "PATCH", { enabled: true })).status).toBe(200);
  return created.body as { token: string; grant: { id: string } };
}
function localAccount(type: "api_key" | "oauth" = "api_key") {
  const account = createAccount({ label: "Local", providers: ["anthropic"] }); const dir = join(root, "agent", "accounts", account.id); mkdirSync(dir, { recursive: true });
  const path = join(dir, "auth.json"); writeFileSync(path, JSON.stringify({ anthropic: type === "api_key" ? { type, key: "LEASE-KEY", refresh: "PRIVATE" } : { type, access: "OLD", refresh: "PRIVATE-REFRESH", expires: 1 } })); return { ...account, path };
}
describe("Backend Peer authentication sharing owner", () => {
  it("owns grant lifecycle, shows creation token once, persists hashes only and rejects duplicate creation", async () => {
    const operationId = randomUUID(); const created = await request("peer-auth/peers", "POST", { label: "Fixture", providers: ["anthropic"] }, true, undefined, operationId);
    const body = created.body as { token: string; grant: { id: string } }; expect(created.status).toBe(201);
    const raw = readFileSync(join(root, "peer-auth.json"), "utf8"); expect(raw).not.toContain(body.token); expect(raw).toContain("tokenSha256");
    expect((await request("peer-auth/peers", "POST", { label: "No replay", providers: ["anthropic"] }, true, undefined, operationId)).status).toBe(409);
    const listed = await request("peer-auth/peers", "GET"); expect(JSON.stringify(listed)).not.toContain(body.token); expect(JSON.stringify(listed)).not.toContain("tokenSha256");
    expect(readFileSync(join(root, "configuration-command.json"), "utf8")).not.toContain(body.token);
    expect((await request("peer-auth/peers", "DELETE", undefined, true, undefined, undefined, `?id=${body.grant.id}`)).status).toBe(200);
  });
  it("requires Peer bearer before body validity, refuses default/wrong-provider access and leases only the selected credential", async () => {
    const account = localAccount(); const { token } = await grant(); const bearer = `Bearer ${token}`;
    expect((await request("peer-auth/resolve", "POST", null, false)).status).toBe(401);
    expect((await request("peer-auth/resolve", "POST", null, false, bearer)).status).toBe(400);
    expect((await request("peer-auth/resolve", "POST", { providerId: "anthropic" }, false, bearer)).status).toBe(403);
    expect((await request("peer-auth/resolve", "POST", { providerId: "openai", accountId: account.id }, false, bearer)).status).toBe(403);
    const listed = await request("peer-auth/list", "GET", undefined, false, bearer); expect(listed.status).toBe(200); expect(JSON.stringify(listed)).not.toContain("LEASE");
    const resolved = await request("peer-auth/resolve", "POST", { providerId: "anthropic", accountId: account.id }, false, bearer);
    expect(resolved.status).toBe(200); expect(resolved.body).toEqual({ credential: { type: "api_key", key: "LEASE-KEY" } }); expect(mocks.getProviderAuthForPeer).not.toHaveBeenCalled();
    const audit = readdirSync(root).find(name => name.includes("audit")); if (audit) expect(readFileSync(join(root, audit), "utf8")).not.toContain("LEASE-KEY");
    await request("peer-auth/peers", "DELETE", undefined, true, undefined, undefined, `?id=${createPeerGrantStore().list()[0].id}`);
    expect((await request("peer-auth/list", "GET", undefined, false, bearer)).status).toBe(401);
  });
  it("refreshes OAuth only at the owner, returns the access lease and never exports the rotated refresh token", async () => {
    const account = localAccount("oauth"); const { token } = await grant();
    mocks.getProviderAuthForPeer.mockImplementationOnce(async () => { writeFileSync(account.path, JSON.stringify({ anthropic: { type: "oauth", access: "NEW-LEASE", refresh: "PRIVATE-ROTATED", expires: Date.now() + 3600000 } })); });
    const result = await request("peer-auth/resolve", "POST", { providerId: "anthropic", accountId: account.id }, false, `Bearer ${token}`);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ credential: { type: "oauth", access: "NEW-LEASE" } }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(mocks.getProviderAuthForPeer).toHaveBeenCalledWith("anthropic", account.id, { minOAuthValidityMs: 600000 });
  });
  it("imports remote accounts/config under WebUI authorization, hides tokens and refuses replay", async () => {
    const token = "R".repeat(43), body = { label: "Remote", peerUrl: "http://peer.test", token };
    expect((await request("peer-auth/import", "POST", body, false)).status).toBe(401); expect(mocks.list).not.toHaveBeenCalled();
    const operationId = randomUUID(); const saved = await request("peer-auth/import", "POST", body, true, undefined, operationId); expect(saved.status).toBe(201); expect(JSON.stringify(saved)).not.toContain(token);
    expect(saved.body).toMatchObject({ accounts: [{ label: "Remote:Source" }], mutation: { saved: true, saveStatus: "complete" } });
    const id = listAccounts()[0].id; expect(JSON.parse(readFileSync(join(root, "agent", "accounts", id, "peer.json"), "utf8")).token).toBe(token);
    expect(JSON.stringify((await request("peer-auth/import", "GET")).body)).not.toContain(token);
    expect((await request("peer-auth/import", "POST", body, true, undefined, operationId)).status).toBe(409); expect(listAccounts()).toHaveLength(1); expect(readFileSync(join(root, "configuration-command.json"), "utf8")).not.toContain(token);
  });
  it("Next refuses service/remote probes/grant and config writers before any filesystem or network effect", async () => {
    vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next"); expect(() => peerAuthService()).toThrow("owned by Backend");
    await expect(importPeerAccount({})).rejects.toThrow("owned by Backend"); await expect(listPeerAccounts()).rejects.toThrow("owned by Backend");
    const store = createPeerGrantStore(); for (const action of [() => store.create({ label: "No", providers: ["anthropic"] }), () => store.setEnabled(true), () => store.revoke("missing"), () => writePeerConfig(join(root, "account"), { version: 1, peerUrl: "http://peer.test", peerAccountId: "remote", providers: ["anthropic"], token: "R".repeat(43), createdAt: new Date().toISOString() }), () => removePeerConfig(join(root, "account"))]) expect(action).toThrow("owned by Backend");
    expect(readdirSync(root)).toEqual([]); expect(mocks.list).not.toHaveBeenCalled();
  });
});
