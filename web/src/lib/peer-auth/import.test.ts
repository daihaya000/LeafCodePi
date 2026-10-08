import { describe, expect, it, vi } from "vitest";
import { importPeerAccount, listPeerAccounts } from "./import";

const TOKEN = "t".repeat(43);
const shared = {
  providers: [
    { providerId: "anthropic", type: "oauth" },
    { providerId: "openai-codex", type: "oauth" },
    { providerId: "unknown-provider", type: "api_key" },
  ],
  accounts: [
    { accountId: null, label: "既定", providers: ["anthropic"] },
    { accountId: "a2", label: "仕事用", providers: ["openai-codex", "unknown-provider"] },
    { accountId: "a3", label: "未使用", providers: ["unknown-provider"] },
  ],
};

function deps(overrides: Record<string, unknown> = {}) {
  let created = 0;
  return {
    listShared: vi.fn(async () => shared),
    createAccount: vi.fn(({ label, providers }: { label: string; providers: string[] }) => ({
      id: `acc-${++created}`, label, enabled: true, providers, createdAt: "t", updatedAt: "t",
    })),
    deleteAccount: vi.fn(),
    writeConfig: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

const valid = { peerUrl: "http://100.64.0.2:3000/ignored", token: TOKEN, label: "X870" };

describe("importPeerAccount", () => {
  it("removes created peer-token configs as well as account records when a later import write fails", async () => {
    const removeConfig = vi.fn(async () => undefined);
    const d = deps({ writeConfig: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("PRIVATE token write failed")), removeConfig });
    const result = await importPeerAccount(valid, d as never);
    expect(result.status).toBe(500); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(d.deleteAccount).toHaveBeenNthCalledWith(1, "acc-1"); expect(d.deleteAccount).toHaveBeenNthCalledWith(2, "acc-2");
    expect(removeConfig).toHaveBeenNthCalledWith(1, "acc-1"); expect(removeConfig).toHaveBeenNthCalledWith(2, "acc-2");
  });
  it("creates one account per sharing-LCP account, with that account's routable providers", async () => {
    const d = deps();
    const result = await importPeerAccount(valid, d as never);
    expect(result.status).toBe(201);
    expect(d.listShared).toHaveBeenCalledWith({ peerUrl: "http://100.64.0.2:3000", token: TOKEN });
    // The third account only holds an unroutable provider, so it is skipped entirely.
    expect(d.createAccount).toHaveBeenCalledTimes(2);
    expect(d.createAccount).toHaveBeenNthCalledWith(1, { label: "X870:既定", providers: ["anthropic"] });
    expect(d.createAccount).toHaveBeenNthCalledWith(2, { label: "X870:仕事用", providers: ["openai-codex"] });
    expect(d.writeConfig).toHaveBeenNthCalledWith(1, "acc-1", { peerUrl: "http://100.64.0.2:3000", peerAccountId: null, providers: ["anthropic"], token: TOKEN });
    expect(d.writeConfig).toHaveBeenNthCalledWith(2, "acc-2", { peerUrl: "http://100.64.0.2:3000", peerAccountId: "a2", providers: ["openai-codex"], token: TOKEN });
    expect((result.body as { accounts: unknown[] }).accounts).toHaveLength(2);
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
  });

  it("narrows to the requested providers per account", async () => {
    const d = deps();
    await importPeerAccount({ ...valid, providers: ["openai-codex", "gemini"] }, d as never);
    expect(d.createAccount).toHaveBeenCalledTimes(1);
    expect(d.createAccount).toHaveBeenCalledWith({ label: "X870:仕事用", providers: ["openai-codex"] });
  });

  it("rejects bad input before contacting the peer", async () => {
    const d = deps();
    for (const input of [null, [], { ...valid, extra: 1 }, { ...valid, peerUrl: "ftp://x" }, { ...valid, token: "short" },
      { ...valid, label: "   " }, { ...valid, providers: "anthropic" }, { ...valid, providers: [1] }]) {
      expect((await importPeerAccount(input, d as never)).status).toBe(400);
    }
    expect(d.listShared).not.toHaveBeenCalled();
    expect(d.createAccount).not.toHaveBeenCalled();
  });

  it("creates nothing when the peer is unreachable or rejects the token (502, opaque)", async () => {
    const d = deps({ listShared: vi.fn(async () => { throw new Error(`Peer auth request failed (401) ${TOKEN}`); }) });
    const result = await importPeerAccount(valid, d as never);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
    expect(d.createAccount).not.toHaveBeenCalled();
  });

  it("returns 400 and creates nothing when no shared provider is usable here", async () => {
    const d = deps({ listShared: vi.fn(async () => ({ providers: [], accounts: [{ accountId: null, label: "既定", providers: ["unknown-provider"] }] })) });
    expect((await importPeerAccount(valid, d as never)).status).toBe(400);
    expect(d.createAccount).not.toHaveBeenCalled();
  });

  it("rolls every created account back when one peer.json write fails", async () => {
    const d = deps({ writeConfig: vi.fn(async (id: string) => { if (id === "acc-2") throw new Error("disk full"); }) });
    const result = await importPeerAccount(valid, d as never);
    expect(result).toEqual({ status: 500, body: { error: "internal error" } });
    expect(d.deleteAccount).toHaveBeenCalledWith("acc-1");
    expect(d.deleteAccount).toHaveBeenCalledWith("acc-2");
  });

  it("surfaces account validation messages (400) and keeps other failures opaque", async () => {
    const invalid = deps({ createAccount: vi.fn(() => { throw Object.assign(new Error("label が不正です"), { status: 400 }); }) });
    expect(await importPeerAccount(valid, invalid as never)).toEqual({ status: 400, body: { error: "label が不正です" } });
    const broken = deps({ createAccount: vi.fn(() => { throw new Error("EACCES /secret"); }) });
    expect(await importPeerAccount(valid, broken as never)).toEqual({ status: 500, body: { error: "internal error" } });
  });
});

describe("listPeerAccounts", () => {
  const peer = { version: 1, peerUrl: "http://100.64.0.2:3000", peerAccountId: null, providers: ["anthropic", "openai-codex"], token: "s".repeat(43), createdAt: "t" };

  function listDeps(overrides: Record<string, unknown> = {}) {
    return {
      listLocalAccounts: vi.fn(() => [
        { id: "peer-1", label: "main", providers: ["anthropic", "openrouter"] },
        { id: "local", label: "local", providers: ["anthropic"] },
      ]),
      readPeer: vi.fn((id: string) => (id === "peer-1" ? peer : null)),
      probe: vi.fn(async () => true),
      ...overrides,
    } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  }

  it("returns only peer accounts, intersected providers and the probe result, without tokens", async () => {
    const d = listDeps({ probe: vi.fn(async (url: string) => url.includes("100.64.0.2")) });
    const rows = await listPeerAccounts(d as never);
    expect(rows).toEqual([{ id: "peer-1", label: "main", peerUrl: "http://100.64.0.2:3000", providers: ["anthropic"], online: true }]);
    expect(JSON.stringify(rows)).not.toContain("s".repeat(43));
    expect(d.readPeer).toHaveBeenCalledWith("local");
  });

  it("reports an unreachable sharing LCP as offline instead of failing", async () => {
    const rows = await listPeerAccounts(listDeps({ probe: vi.fn(async () => false) }) as never);
    expect(rows[0].online).toBe(false);
  });

  it("returns an empty list when no account is a peer account", async () => {
    const rows = await listPeerAccounts(listDeps({ readPeer: vi.fn(() => null) }) as never);
    expect(rows).toEqual([]);
  });
});
