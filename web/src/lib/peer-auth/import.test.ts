import { describe, expect, it, vi } from "vitest";
import { importPeerAccount } from "./import";

const TOKEN = "t".repeat(43);
const record = { id: "acc-1", label: "peer", enabled: true, providers: ["anthropic"], createdAt: "t", updatedAt: "t" };

function deps(overrides: Record<string, unknown> = {}) {
  return {
    listShared: vi.fn(async () => [{ providerId: "anthropic", type: "oauth" }, { providerId: "unknown-provider", type: "api_key" }, { providerId: "openrouter", type: "api_key" }]),
    createAccount: vi.fn(() => record),
    deleteAccount: vi.fn(),
    writeConfig: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

const valid = { peerUrl: "http://100.64.0.2:3000/ignored", token: TOKEN, label: "peer" };

describe("importPeerAccount", () => {
  it("tests the connection, keeps only providers this LCP can route, and stores the token in peer.json only", async () => {
    const d = deps() as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const result = await importPeerAccount(valid, d as never);
    expect(result.status).toBe(201);
    expect(d.listShared).toHaveBeenCalledWith({ peerUrl: "http://100.64.0.2:3000", token: TOKEN });
    expect(d.createAccount).toHaveBeenCalledWith({ label: "peer", providers: ["anthropic", "openrouter"] });
    expect(d.writeConfig).toHaveBeenCalledWith("acc-1", { peerUrl: "http://100.64.0.2:3000", peerAccountId: null, providers: ["anthropic", "openrouter"], token: TOKEN });
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
  });

  it("narrows to the requested providers", async () => {
    const d = deps() as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await importPeerAccount({ ...valid, providers: ["openrouter", "gemini"] }, d as never);
    expect(d.createAccount).toHaveBeenCalledWith({ label: "peer", providers: ["openrouter"] });
  });

  it("rejects bad input before contacting the peer", async () => {
    const d = deps() as unknown as Record<string, ReturnType<typeof vi.fn>>;
    for (const input of [null, [], { ...valid, extra: 1 }, { ...valid, peerUrl: "ftp://x" }, { ...valid, token: "short" },
      { ...valid, providers: "anthropic" }, { ...valid, providers: [1] }]) {
      expect((await importPeerAccount(input, d as never)).status).toBe(400);
    }
    expect(d.listShared).not.toHaveBeenCalled();
    expect(d.createAccount).not.toHaveBeenCalled();
  });

  it("creates nothing when the peer is unreachable or rejects the token (502, opaque)", async () => {
    const d = deps({ listShared: vi.fn(async () => { throw new Error(`Peer auth request failed (401) ${TOKEN}`); }) }) as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const result = await importPeerAccount(valid, d as never);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
    expect(d.createAccount).not.toHaveBeenCalled();
  });

  it("returns 400 and creates nothing when no shared provider is usable here", async () => {
    const d = deps({ listShared: vi.fn(async () => [{ providerId: "unknown-provider", type: "oauth" }]) }) as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect((await importPeerAccount(valid, d as never)).status).toBe(400);
    expect(d.createAccount).not.toHaveBeenCalled();
  });

  it("surfaces account validation messages (400) and keeps other failures opaque", async () => {
    const invalid = deps({ createAccount: vi.fn(() => { throw Object.assign(new Error("label が不正です"), { status: 400 }); }) });
    expect(await importPeerAccount(valid, invalid)).toEqual({ status: 400, body: { error: "label が不正です" } });
    const broken = deps({ createAccount: vi.fn(() => { throw new Error("EACCES /secret"); }) });
    expect(await importPeerAccount(valid, broken)).toEqual({ status: 500, body: { error: "internal error" } });
  });

  it("rolls the account back when writing peer.json fails", async () => {
    const d = deps({ writeConfig: vi.fn(async () => { throw new Error("disk full"); }) }) as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const result = await importPeerAccount(valid, d as never);
    expect(result).toEqual({ status: 500, body: { error: "internal error" } });
    expect(d.deleteAccount).toHaveBeenCalledWith("acc-1");
  });
});
