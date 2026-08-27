import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, it } from "vitest";
import { createAccount } from "@/lib/accounts";
import { accountOllamaCookiePath } from "@/lib/codexbar/providers/ollama-cloud";
import { DELETE, POST } from "./route";

const dirs: string[] = [];
const previousAppData = process.env.APPDATA;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.LEAFCODE_PI_DATA_DIR;
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "leafcode-ollama-cookie-api-"));
  dirs.push(dataDir);
  process.env.LEAFCODE_PI_DATA_DIR = dataDir;
  process.env.APPDATA = join(dataDir, "appdata");
}

function request(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

const validCookies = `# Netscape HTTP Cookie File
.ollama.com\tTRUE\t/\tTRUE\t0\tsession\taccount-cookie
`;

describe("/api/accounts/[id]/ollama-cookie", () => {
  it("saves a valid account cookie without returning its contents", async () => {
    setup();
    const account = createAccount({ label: "Ollama 個人用", providers: ["ollama-cloud"] });

    const response = await POST(
      request(`http://localhost/api/accounts/${account.id}/ollama-cookie`, "POST", {
        cookies: validCookies,
      }),
      context(account.id),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, configured: true });
    const path = accountOllamaCookiePath(account.id);
    assert.ok(path);
    assert.equal(existsSync(path), true);
    assert.match(readFileSync(path, "utf8"), /session\taccount-cookie/);
  });

  it("rejects invalid cookies and accounts without Ollama", async () => {
    setup();
    const ollama = createAccount({ label: "Ollama", providers: ["ollama-cloud"] });
    const openrouter = createAccount({ label: "OpenRouter", providers: ["openrouter"] });

    const invalid = await POST(
      request(`http://localhost/api/accounts/${ollama.id}/ollama-cookie`, "POST", {
        cookies: "not a Netscape cookie",
      }),
      context(ollama.id),
    );
    assert.equal(invalid.status, 400);

    const wrongProvider = await POST(
      request(`http://localhost/api/accounts/${openrouter.id}/ollama-cookie`, "POST", {
        cookies: validCookies,
      }),
      context(openrouter.id),
    );
    assert.equal(wrongProvider.status, 400);

    const missing = await POST(
      request("http://localhost/api/accounts/missing/ollama-cookie", "POST", {
        cookies: validCookies,
      }),
      context("missing"),
    );
    assert.equal(missing.status, 404);
  });

  it("deletes only the selected account cookie", async () => {
    setup();
    const account = createAccount({ label: "Ollama", providers: ["ollama-cloud"] });
    await POST(
      request(`http://localhost/api/accounts/${account.id}/ollama-cookie`, "POST", {
        cookies: validCookies,
      }),
      context(account.id),
    );
    const path = accountOllamaCookiePath(account.id);
    assert.ok(path && existsSync(path));

    const response = await DELETE(
      request(`http://localhost/api/accounts/${account.id}/ollama-cookie`, "DELETE"),
      context(account.id),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, configured: false });
    assert.equal(existsSync(path), false);
  });
});
