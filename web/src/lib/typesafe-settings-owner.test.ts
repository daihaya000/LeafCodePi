import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { readTypesafeSettings, mutateTypesafeSettings } from "@backend-runtime/lib/typesafe-settings-api";
import * as cookies from "@backend-runtime/lib/codexbar/browser-cookies";
import * as baseline from "@backend-runtime/lib/codexbar/providers/typesafe";
import * as usageCache from "@backend-runtime/lib/codexbar/cache";
import * as providerCache from "@backend-runtime/lib/codexbar/provider-cache";
import * as cookieHandlers from "@backend-runtime/json-business/handlers/typesafe-cookie/route";
import * as baselineHandlers from "@backend-runtime/json-business/handlers/typesafe-baseline/route";
let root: string;
const validCookies = "# Netscape HTTP Cookie File\nconsole.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\tfixture-session\nconsole.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\tfixture-org\nconsole.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tcsrf_token\tfixture-csrf\n.other.example\tTRUE\t/\tTRUE\t4102444800\tthird_party_auth\tforeign-secret\n";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-typesafe-owner-")); for (const [key, value] of Object.entries({ LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_BACKEND_RUNTIME: "attach", LEAFCODE_PI_DATA_DIR: join(root, "data"), APPDATA: root, PI_CODING_AGENT_DIR: join(root, "agent") })) vi.stubEnv(key, value); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function request(route: string, method: string, body?: unknown, id: string = randomUUID(), authorized = true, origin?: string, signal?: AbortSignal) {
  const result = await dispatchJsonBusinessRequest({ route, method, url: "http://localhost/api/" + route, headers: { host: "localhost", ...(origin ? { origin } : {}) }, authorized, operationId: method === "GET" ? undefined : id, signal, ...(body === undefined ? {} : { body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)) }) });
  const projected = publicJsonBusinessResult(route, result, method); expect(projected).not.toBeNull();
  if (!projected?.body) throw new Error("Invalid owner DTO");
  return { ...projected, body: projected.body as { configured?: boolean; baselineUsd?: number | null; operation?: { id: string; execution: string } } };
}
describe("TypeSafe private credential/billing-display owner", () => {
  it("roundtrips all six operations, filters foreign domains, invalidates owner caches and keeps the ID ledger secret-free", async () => {
    const invalidUsage = vi.spyOn(usageCache, "invalidateCachedUsage"), clear = vi.spyOn(providerCache, "clearProviderCache");
    expect((await request("typesafe-cookie", "GET")).body).toEqual({ configured: false }); expect((await request("typesafe-baseline", "GET")).body).toEqual({ baselineUsd: null }); expect(existsSync(join(root, "data", "typesafe-settings-command.json"))).toBe(false);
    const saved = await request("typesafe-cookie", "POST", { cookies: validCookies, path: join(root, "forged.txt"), accountId: "forged" });
    expect(saved.status).toBe(200); expect(saved.body.operation?.execution).toBe("complete"); expect(JSON.stringify(saved)).not.toContain("fixture-session");
    const path = cookies.defaultTypesafeCookiePath(), text = readFileSync(path, "utf8"); expect(text).toContain("fixture-session"); expect(text).toContain("fixture-org"); expect(text).toContain("fixture-csrf"); expect(text).not.toContain("foreign-secret"); expect(existsSync(join(root, "forged.txt"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await request("typesafe-cookie", "GET")).body).toEqual({ configured: true });
    expect((await request("typesafe-baseline", "POST", { baselineUsd: 10.25, cookies: "ignored" })).status).toBe(200); expect((await request("typesafe-baseline", "GET")).body).toEqual({ baselineUsd: 10.25 });
    expect((await request("typesafe-cookie", "DELETE", {})).body.configured).toBe(false); expect(existsSync(path)).toBe(false);
    expect((await request("typesafe-baseline", "DELETE", {})).body.baselineUsd).toBeNull(); expect(baseline.readTypesafeCreditBaseline()).toBeNull();
    expect(invalidUsage).toHaveBeenCalledTimes(4); expect(clear).toHaveBeenCalledTimes(4); expect(clear.mock.calls.every(([id]) => id === "default:typesafe")).toBe(true);
    const ledger = readFileSync(join(root, "data", "typesafe-settings-command.json"), "utf8"); expect(ledger).not.toMatch(/fixture-session|fixture-org|fixture-csrf|foreign-secret|cookies|baselineUsd|forged|path/); expect(JSON.parse(ledger).operations).toHaveLength(4);
  });
  it("validates before credential/cache effects, denies auth/Origin/bounds/invalid IDs before admission and keeps safe refusals complete", async () => {
    const save = vi.spyOn(cookies, "saveTypesafeCookieFile"), invalidate = vi.spyOn(usageCache, "invalidateCachedUsage");
    for (const body of [null, [], { cookies: 3 }, { cookies: "session_id=only" }, { cookies: "not-a-cookie" }, { cookies: "x".repeat(1_000_001) }]) { const result = await request("typesafe-cookie", "POST", body); expect(result.status).toBe(400); expect(result.body.operation?.execution).toBe("complete"); }
    for (const body of [null, [], { baselineUsd: -1 }, { baselineUsd: 0 }, { baselineUsd: "5" }, { baselineUsd: 1_000_001 }]) expect((await request("typesafe-baseline", "POST", body)).status).toBe(400);
    expect(invalidate).not.toHaveBeenCalled(); expect(existsSync(cookies.defaultTypesafeCookiePath())).toBe(false);
    const calls = save.mock.calls.length;
    expect((await request("typesafe-cookie", "POST", { cookies: validCookies }, randomUUID(), false)).status).toBe(401); expect((await request("typesafe-cookie", "POST", { cookies: validCookies }, randomUUID(), true, "https://evil.example")).status).toBe(403);
    expect((await request("typesafe-cookie", "POST", { cookies: validCookies }, "bad")).status).toBe(400);
    expect((await request("typesafe-baseline", "POST", "x".repeat(4097))).status).toBe(413); expect((await request("typesafe-cookie", "DELETE", "x".repeat(4097))).status).toBe(413); expect((await request("typesafe-cookie", "POST", "x".repeat(8 * 1024 * 1024 + 1))).status).toBe(413);
    expect(save).toHaveBeenCalledTimes(calls);
  });
  it("preserves saved bytes and reports cache/application exceptions as unknown even for typed 4xx, with no replay", async () => {
    vi.spyOn(usageCache, "invalidateCachedUsage").mockImplementationOnce(() => { throw Object.assign(new Error("PRIVATE fixture-session"), { status: 400 }); });
    const id = randomUUID(), result = await request("typesafe-cookie", "POST", { cookies: validCookies }, id);
    expect(result.status).toBe(503); expect(result.body.operation?.execution).toBe("unknown"); expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect((await request("typesafe-cookie", "GET")).body.configured).toBe(true);
    const before = readFileSync(cookies.defaultTypesafeCookiePath(), "utf8"); const replay = await request("typesafe-cookie", "POST", { cookies: "changed" }, id); expect(replay.status).toBe(409); expect(replay.body.operation?.execution).toBe("unknown"); expect(readFileSync(cookies.defaultTypesafeCookiePath(), "utf8")).toBe(before);
    vi.spyOn(providerCache, "clearProviderCache").mockImplementationOnce(() => { throw Object.assign(new Error("PRIVATE path"), { status: 404 }); }); const savedBaseline = await request("typesafe-baseline", "POST", { baselineUsd: 9 }); expect(savedBaseline.status).toBe(503); expect(savedBaseline.body.operation?.execution).toBe("unknown"); expect(baseline.readTypesafeCreditBaseline()).toBe(9);
  });
  it("does not fake successful deletion on filesystem failures; malformed writer success is rejected", async () => {
    const cookiePath = cookies.defaultTypesafeCookiePath(); mkdirSync(cookiePath, { recursive: true }); writeFileSync(join(cookiePath, "keep"), "fixture");
    const failedCookie = await request("typesafe-cookie", "DELETE", {}); expect(failedCookie.status).toBe(503); expect(failedCookie.body.operation?.execution).toBe("unknown"); expect(existsSync(join(cookiePath, "keep"))).toBe(true);
    const failedCookieWrite = await request("typesafe-cookie", "POST", { cookies: validCookies }); expect(failedCookieWrite.status).toBe(503); expect(failedCookieWrite.body.operation?.execution).toBe("unknown"); expect(readFileSync(join(cookiePath, "keep"), "utf8")).toBe("fixture");
    const baselinePath = join(root, "CodexBar", "typesafe.json"); mkdirSync(baselinePath, { recursive: true }); writeFileSync(join(baselinePath, "keep"), "fixture"); const failedBaseline = await request("typesafe-baseline", "DELETE", {}); expect(failedBaseline.status).toBe(503); expect(failedBaseline.body.operation?.execution).toBe("unknown"); expect(existsSync(join(baselinePath, "keep"))).toBe(true);
    vi.spyOn(baseline, "readTypesafeCreditBaseline").mockReturnValueOnce(NaN); const malformed = await request("typesafe-baseline", "GET"); expect(malformed.status).toBe(503); expect(malformed.body).toEqual({ error: "TypeSafe設定の処理結果を確認できません" });
  });
  it("serializes accepted updates, retains completion after disconnect, and refuses corrupt ledgers before writes", async () => {
    const abort = new AbortController(); abort.abort(); const id = randomUUID(); const pending = request("typesafe-baseline", "POST", { baselineUsd: 7 }, id, true, undefined, abort.signal); const duplicate = request("typesafe-baseline", "POST", { baselineUsd: 8 }, id); expect((await pending).status).toBe(200); expect((await duplicate).status).toBe(409); expect(baseline.readTypesafeCreditBaseline()).toBe(7);
    writeFileSync(join(root, "data", "typesafe-settings-command.json"), "corrupt"); const failed = await request("typesafe-cookie", "POST", { cookies: validCookies }); expect(failed.status).toBe(503); expect(failed.body.operation?.execution).toBe("not-started"); expect(existsSync(cookies.defaultTypesafeCookiePath())).toBe(false);
  });
  it("guards every handler/service/common writer before filesystem and cache effects in Next", async () => {
    const invalidate = vi.spyOn(usageCache, "invalidateCachedUsage"); vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next");
    for (const fn of [() => readTypesafeSettings(true), () => readTypesafeSettings(false), () => mutateTypesafeSettings(true, "POST", { cookies: validCookies }), () => mutateTypesafeSettings(false, "DELETE", null), () => cookies.saveTypesafeCookieFile(validCookies), () => cookies.deleteTypesafeCookieFile(), () => baseline.writeTypesafeCreditBaseline(3)]) expect(fn).toThrow("Configuration is owned by Backend");
    for (const handlers of [cookieHandlers, baselineHandlers]) { expect(() => handlers.GET()).toThrow("Configuration is owned by Backend"); expect(() => handlers.DELETE()).toThrow("Configuration is owned by Backend"); await expect(handlers.POST(new Request("http://localhost", { method: "POST", body: "{}" }))).rejects.toThrow("Configuration is owned by Backend"); }
    expect(invalidate).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual([]);
  });
});
