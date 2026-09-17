import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultTypesafeCookiePath } from "@/lib/codexbar/browser-cookies";
import { DELETE, GET, POST } from "./route";

const previousAppData = process.env.APPDATA;
let appData: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), "leafcode-typesafe-cookie-api-"));
  process.env.APPDATA = appData;
});

afterEach(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  rmSync(appData, { recursive: true, force: true });
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/typesafe-cookie", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validCookies = `# Netscape HTTP Cookie File
console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok-123
console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg_abc
.other.example\tTRUE\t/\tTRUE\t4102444800\tthird_party_auth\tunrelated-secret
`;

describe("/api/typesafe-cookie", () => {
  it("saves only a complete TypeSafe Console cookie and never returns its content", async () => {
    expect(await GET().json()).toEqual({ configured: false });

    const response = await POST(request({ cookies: validCookies }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, configured: true });
    expect(existsSync(defaultTypesafeCookiePath())).toBe(true);
    const stored = readFileSync(defaultTypesafeCookiePath(), "utf8");
    expect(stored).toContain("session_id\ttok-123");
    expect(stored).toContain("organization_id\torg_abc");
    expect(stored).not.toContain("other.example");
    expect(stored).not.toContain("unrelated-secret");
    expect(JSON.stringify(await GET().json())).not.toContain("tok-123");
    expect(await GET().json()).toEqual({ configured: true });
  });

  it("rejects malformed, wrong-domain, and session-only inputs", async () => {
    for (const cookies of [
      "not a cookie file",
      "other.example\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n",
      "console.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\ttok\n",
    ]) {
      const response = await POST(request({ cookies }));
      expect(response.status).toBe(400);
    }
    const malformedBody = await POST(request({ cookies: 1 }));
    expect(malformedBody.status).toBe(400);
  });

  it("deletes the saved cookie", async () => {
    await POST(request({ cookies: validCookies }));
    expect(existsSync(defaultTypesafeCookiePath())).toBe(true);

    const response = DELETE();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, configured: false });
    expect(existsSync(defaultTypesafeCookiePath())).toBe(false);
    expect(await GET().json()).toEqual({ configured: false });
  });
});
