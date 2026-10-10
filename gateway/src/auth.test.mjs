import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { webAuthGate, refreshAuthCookie } from "./auth.mjs";
import { requestCookie, setResponseCookie } from "../../shared/http-cookie.mjs";
const baseline = JSON.parse(readFileSync(new URL("../fixtures/auth-contract.json", import.meta.url)));
function cookies(response) { return response.headers.getSetCookie().map(value => value.replace(/Expires=[^;]+/, "Expires=<clock>")); }

test("browser auth retains the independently captured ingress contract without a framework reference runtime", async t => {
  const saved = [process.env.LEAFCODE_PI_WEBUI_AUTH, process.env.LEAFCODE_PI_WEBUI_TOKEN];
  t.after(() => { ["LEAFCODE_PI_WEBUI_AUTH", "LEAFCODE_PI_WEBUI_TOKEN"].forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); });
  let index = 0;
  for (const required of ["required", "disabled"]) for (const token of ["finite-token", ""]) {
    process.env.LEAFCODE_PI_WEBUI_AUTH = required; process.env.LEAFCODE_PI_WEBUI_TOKEN = token;
    for (const path of baseline.paths) for (const headers of baseline.headers) {
      const expected = baseline.cases[index++], gate = webAuthGate(new Request(new URL(path, "https://finite.invalid"), { headers }));
      const actual = gate.response ? { status: gate.response.status, location: gate.response.headers.get("location"), cache: gate.response.headers.get("cache-control"), referrer: gate.response.headers.get("referrer-policy"), body: await gate.response.text(), cookies: cookies(gate.response) }
        : { pass: true, cookies: cookies(refreshAuthCookie(new Response(null), gate)) };
      assert.deepEqual(actual, expected, `${required} ${path} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(index, baseline.cases.length); t.diagnostic(`${index} frozen pre-removal auth observations`);
});

test("cookie serialization, replacement, expiration and malformed parsing retain captured observations", () => {
  for (const { value, options, expected } of baseline.cookieCases) {
    const response = Response.json({}), normalized = { ...options, ...(options.expires ? { expires: new Date(options.expires) } : {}) };
    setResponseCookie(response, "other", "one"); setResponseCookie(response, "leafcode-pi-token", "old"); setResponseCookie(response, "leafcode-pi-token", value, normalized);
    assert.deepEqual(cookies(response), expected);
  }
  for (const { input, value } of baseline.parseCases) assert.equal(requestCookie(new Headers({ cookie: input }), "leafcode-pi-token") ?? null, value);
});

test("approved browser refresh never overwrites a cookie deliberately changed by the handler", () => {
  const response = setResponseCookie(Response.json({ ok: true }), "leafcode-pi-token", "rotated", { httpOnly: true, sameSite: "lax" });
  refreshAuthCookie(response, { refreshCookie: true, cookie: "old" });
  assert.deepEqual(cookies(response), ["leafcode-pi-token=old; Path=/; Expires=<clock>; Max-Age=31536000; HttpOnly; SameSite=lax", "leafcode-pi-token=rotated; Path=/; HttpOnly; SameSite=lax"]);
});
