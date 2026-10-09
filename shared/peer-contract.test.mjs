import test from "node:test";
import assert from "node:assert/strict";
import { PEER_ROUTES, peerFacing, peerCommand, publicPeerBody } from "./peer-contract.mjs";
import { jsonBusinessBodyLimit, jsonBusinessCommand, jsonBusinessMutates, publicJsonBusinessResult } from "./json-business-contract.mjs";
const token = "T".repeat(43);
test("Peer routes separate WebUI commands and bearer-only operations with a bounded body", () => {
  assert.equal(Object.values(PEER_ROUTES).flat().length, 9);
  assert.equal(peerFacing("peer-auth/resolve"), true); assert.equal(peerFacing("peer-auth/import"), false);
  assert.equal(peerCommand("peer-auth/peers", "POST"), true); assert.equal(jsonBusinessCommand("peer-auth/resolve", "POST"), false);
  assert.equal(jsonBusinessBodyLimit("peer-auth/resolve"), 4096);
  assert.equal(jsonBusinessMutates("peer-auth/resolve", "POST"), false); assert.equal(jsonBusinessMutates("peer-auth/usage", "POST"), false);
  assert.equal(jsonBusinessMutates("peer-auth/import", "POST"), true);
});
test("only authorized Peer resolve protocol projects a short-lived access credential, never refresh or SDK properties", () => {
  const input = { credential: { type: "oauth", access: "LEASE", expires: 12345, refresh: "PRIVATE", token: "PRIVATE" }, refresh: "PRIVATE" };
  assert.deepEqual(publicPeerBody("peer-auth/resolve", input, 200), { credential: { type: "oauth", access: "LEASE", expires: 12345 } });
  const list = publicPeerBody("peer-auth/list", { providers: [{ providerId: "anthropic", type: "oauth", access: "PRIVATE" }], accounts: [{ accountId: "a", label: "Account", providers: ["anthropic"], token: "PRIVATE" }], credential: input.credential }, 200);
  assert.ok(!JSON.stringify(list).includes("PRIVATE")); assert.ok(!JSON.stringify(list).includes("LEASE"));
  assert.equal(publicPeerBody("peer-auth/resolve", { credential: { type: "oauth", access: {}, expires: 1 } }, 200), null);
});
test("grant token is a one-time creation response; later metadata omits token and hash", () => {
  const grant = { id: "g", label: "Peer", providers: ["anthropic"], createdAt: "now", tokenSha256: "PRIVATE" };
  assert.deepEqual(publicPeerBody("peer-auth/peers", { grant, token }, 201), { grant: { id: "g", label: "Peer", providers: ["anthropic"], createdAt: "now" }, token });
  const metadata = publicPeerBody("peer-auth/peers", { enabled: true, authRequired: true, grants: [grant], token }, 200);
  assert.ok(!JSON.stringify(metadata).includes(token)); assert.ok(!JSON.stringify(metadata).includes("PRIVATE"));
  assert.equal(publicPeerBody("peer-auth/peers", { grant, token }, 200), null);
});
test("peer import rows/usage remain metadata only, preserve Retry-After and reject credential-bearing URLs", () => {
  const row = { id: "a", label: "Peer account", peerUrl: "http://peer.test", providers: ["anthropic"], online: true, token: "PRIVATE" };
  assert.ok(!JSON.stringify(publicPeerBody("peer-auth/import", { peers: [row] }, 200)).includes("PRIVATE"));
  assert.equal(publicPeerBody("peer-auth/import", { peers: [{ ...row, peerUrl: "http://user:secret@peer.test" }] }, 200), null);
  assert.deepEqual(publicJsonBusinessResult("peer-auth/resolve", { status: 429, headers: { "retry-after": "7", "set-cookie": "PRIVATE" }, body: { error: "rate-limited", token: "PRIVATE" } }), { status: 429, headers: { "retry-after": "7" }, body: { error: "rate-limited" } });
  assert.deepEqual(publicPeerBody("peer-auth/usage", { providers: [{ providerId: "anthropic", snapshot: null, credential: "PRIVATE" }] }, 200), { providers: [{ providerId: "anthropic", snapshot: null }] });
});
