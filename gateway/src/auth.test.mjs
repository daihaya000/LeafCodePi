import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { webAuthGate, refreshAuthCookie } from "./auth.mjs";
import { requestCookie, setResponseCookie } from "../../shared/http-cookie.mjs";
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const require = createRequire(join(ROOT, "web/package.json"));
const { NextRequest, NextResponse } = require("next/server"), ts = require("typescript");
function cookies(response) { return response.headers.getSetCookie().map(value => value.replace(/Expires=[^;]+/, "Expires=<clock>")); }

test("browser authorization, public exceptions and redirect ordering match the existing Next proxy", async t => {
  const root = mkdtempSync(join(tmpdir(), "gateway-auth-reference-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = { auth: process.env.LEAFCODE_PI_WEBUI_AUTH, token: process.env.LEAFCODE_PI_WEBUI_TOKEN };
  t.after(() => { for (const [name, value] of [["LEAFCODE_PI_WEBUI_AUTH", saved.auth], ["LEAFCODE_PI_WEBUI_TOKEN", saved.token]]) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  writeFileSync(join(root, "shared.cjs"), compile(readFileSync(join(ROOT, "shared/webui-auth-shared.ts"), "utf8")));
  const proxySource = readFileSync(join(ROOT, "web/src/proxy.ts"), "utf8").replace('"next/server"', JSON.stringify(require.resolve("next/server"))).replace('"@/lib/webui-auth-shared"', JSON.stringify(join(root, "shared.cjs")));
  writeFileSync(join(root, "proxy.cjs"), compile(proxySource)); const { proxy } = require(join(root, "proxy.cjs"));
  const headers = [{}, { cookie: "leafcode-pi-token=finite-token" }, { authorization: "Bearer finite-token" }, { cookie: "leafcode-pi-token=finite-token", authorization: "Bearer wrong" }, { cookie: "leafcode-pi-token=wrong", authorization: "Bearer finite-token" }, { cookie: "leafcode-pi-token=%ZZ" }];
  const paths = ["/", "/task/id?q=1", "/task/id?token=secret&q=1", "/api/tasks?token=finite-token", "/login", "/login?next=/task/id", "/login?next=//evil.invalid", "/login?next=/\\evil.invalid", "/login?next=/login", "/api/auth/webui", "/api/auth/webui-extra", "/api/health", "/api/host-probe", "/webui-bootstrap.json", "/webui-bootstrap.json?fixture=1", "/webui-bootstrap.json-extra", "/api/peer-auth/list", "/api/peer-auth/resolve", "/api/peer-auth/usage", "/api/peer-auth/not-public", "/_next/static/chunk.js", "/favicon.ico"];
  let compared = 0;
  for (const required of ["required", "disabled"]) for (const token of ["finite-token", ""]) {
    process.env.LEAFCODE_PI_WEBUI_AUTH = required; process.env.LEAFCODE_PI_WEBUI_TOKEN = token;
    for (const path of paths) for (const values of headers) {
      const url = new URL(path, "https://finite.invalid"); const expected = proxy(new NextRequest(url, { headers: values }));
      const gate = webAuthGate(new Request(url, { headers: values }));
      if (expected.headers.has("x-middleware-next")) { assert.equal(gate.response, undefined); assert.deepEqual(cookies(refreshAuthCookie(new Response(null), gate)), cookies(expected)); }
      else { assert.equal(gate.response?.status, expected.status, `${required} ${path}`); assert.equal(gate.response.headers.get("location"), expected.headers.get("location")); assert.equal(gate.response.headers.get("cache-control"), expected.headers.get("cache-control")); assert.equal(gate.response.headers.get("referrer-policy"), expected.headers.get("referrer-policy")); assert.equal(await gate.response.text(), await expected.text()); assert.deepEqual(cookies(gate.response), cookies(expected)); }
      compared++;
    }
  }
  t.diagnostic(`${compared} original-proxy observations including missing token, query removal, bearer priority, open-redirect refusal and public/peer exceptions`);
});

test("cookie serialization and parsing match Next including replacement, expired cookie and malformed input", () => {
  for (const value of ["finite-token", "日本語 /+%=", ""]) for (const options of [{ httpOnly: true, sameSite: "lax", path: "/", maxAge: 31536000 }, { maxAge: 0 }, { path: "/test", secure: true, domain: "finite.invalid", sameSite: "strict", expires: new Date("2020-01-01") }]) {
    const expected = NextResponse.json({}), actual = Response.json({});
    expected.cookies.set("other", "one"); setResponseCookie(actual, "other", "one");
    expected.cookies.set("leafcode-pi-token", "old"); setResponseCookie(actual, "leafcode-pi-token", "old");
    expected.cookies.set("leafcode-pi-token", value, options); setResponseCookie(actual, "leafcode-pi-token", value, options);
    assert.deepEqual(cookies(actual), cookies(expected));
  }
  for (const cookie of ["a=one; leafcode-pi-token=first; leafcode-pi-token=last", "leafcode-pi-token=%ZZ", "leafcode-pi-token", "leafcode-pi-token=%E6%97%A5%E6%9C%AC", "a=b; leafcode-pi-token=one=two", ""]) {
    const next = new NextRequest("https://finite.invalid", { headers: { cookie } });
    assert.equal(requestCookie(next.headers, "leafcode-pi-token"), next.cookies.get("leafcode-pi-token")?.value, cookie);
  }
});

test("approved browser refresh never overwrites a cookie deliberately changed by the handler", () => {
  const response = setResponseCookie(Response.json({ ok: true }), "leafcode-pi-token", "rotated", { httpOnly: true, sameSite: "lax" });
  refreshAuthCookie(response, { refreshCookie: true, cookie: "old" });
  assert.deepEqual(cookies(response), ["leafcode-pi-token=old; Path=/; Expires=<clock>; Max-Age=31536000; HttpOnly; SameSite=lax", "leafcode-pi-token=rotated; Path=/; HttpOnly; SameSite=lax"]);
});
