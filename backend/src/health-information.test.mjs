import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createBackendServer, listenBackend, closeBackend } from "./server.mjs";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { JSON_BUSINESS_PATH, JSON_BUSINESS_HEADERS } from "../../shared/json-business-contract.mjs";
import { publicBackendHealthBody } from "../../shared/backend-health-contract.mjs";
test("runtime health permits only the public read under the internal bearer/protocol boundary; cache mutation remains private", async t => {
  const old = process.env.LEAFCODE_PI_WEBUI_AUTH; process.env.LEAFCODE_PI_WEBUI_AUTH = "required"; t.after(() => { if (old === undefined) delete process.env.LEAFCODE_PI_WEBUI_AUTH; else process.env.LEAFCODE_PI_WEBUI_AUTH = old; });
  const token = randomBytes(32).toString("base64url"), seen = [];
  const server = createBackendServer({ token, isReady: () => true, jsonBusinessRequestAction: async input => {
    seen.push(input); return { status: 200, headers: {}, body: input.route === "health/cache" ? { ok: true } : publicBackendHealthBody({ ok: true, engine: "pi", engineOk: true, version: "1", modelCount: 1, dataDir: "/PRIVATE", warnings: ["PRIVATE"], error: "PRIVATE" }, 200, input.authorized) };
  } }); t.after(() => closeBackend(server)); const address = await listenBackend(server, 0), base = `http://127.0.0.1:${address.port}${JSON_BUSINESS_PATH}`;
  const headers = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION), [JSON_BUSINESS_HEADERS.origin]: "http://localhost", [JSON_BUSINESS_HEADERS.host]: "localhost", [JSON_BUSINESS_HEADERS.authorized]: "0" };
  assert.equal((await fetch(base + "/health")).status, 401);
  const publicResult = await (await fetch(base + "/health", { headers })).json(); assert.equal(publicResult.status, 200); assert.ok(!JSON.stringify(publicResult).includes("PRIVATE"));
  assert.equal((await fetch(base + "/health", { method: "POST", headers })).status, 405);
  assert.equal((await fetch(base + "/health/cache", { method: "POST", headers })).status, 403);
  const authenticated = { ...headers, [JSON_BUSINESS_HEADERS.authorized]: "1" };
  assert.equal((await (await fetch(base + "/health", { headers: authenticated })).json()).body.dataDir, "/PRIVATE");
  assert.equal((await (await fetch(base + "/health/cache", { method: "POST", headers: authenticated })).json()).body.ok, true); assert.equal(seen.length, 3);
});
