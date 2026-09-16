import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, it } from "vitest";
import {
  __resetPiAgentDirCacheForTests,
  accountAuthPath,
  createAccount,
} from "@/lib/accounts";
import { accountAnthropicCookiePath } from "@/lib/codexbar/browser-cookies";
import { DELETE, POST } from "./route";

const dirs: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  delete process.env.LEAFCODE_PI_DATA_DIR;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  __resetPiAgentDirCacheForTests();
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "leafcode-anthropic-cookie-api-"));
  dirs.push(dataDir);
  process.env.LEAFCODE_PI_DATA_DIR = dataDir;
  process.env.PI_CODING_AGENT_DIR = join(dataDir, "agent");
  __resetPiAgentDirCacheForTests();
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
.claude.com\tTRUE\t/\tTRUE\t4102444800\tsessionKey\tsk-ant-sid01-account
.claude.com\tTRUE\t/\tTRUE\t4102444800\tlastActiveOrg\t00000000-0000-0000-0000-000000000001
`;

describe("/api/accounts/[id]/anthropic-cookie", () => {
  it("saves a valid Console cookie without returning its contents", async () => {
    setup();
    const account = createAccount({
      label: "Anthropic API",
      providers: ["anthropic"],
    });

    const response = await POST(
      request(
        `http://localhost/api/accounts/${account.id}/anthropic-cookie`,
        "POST",
        { cookies: validCookies },
      ),
      context(account.id),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, configured: true });
    const path = accountAnthropicCookiePath(
      accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!),
    );
    assert.equal(existsSync(path), true);
    assert.match(readFileSync(path, "utf8"), /sessionKey\tsk-ant-sid01-account/);
  });

  it("rejects cookies without a Console session and accounts without Anthropic", async () => {
    setup();
    const anthropic = createAccount({
      label: "Anthropic API",
      providers: ["anthropic"],
    });
    const openrouter = createAccount({
      label: "OpenRouter",
      providers: ["openrouter"],
    });

    const invalid = await POST(
      request(
        `http://localhost/api/accounts/${anthropic.id}/anthropic-cookie`,
        "POST",
        { cookies: "not a Netscape cookie" },
      ),
      context(anthropic.id),
    );
    assert.equal(invalid.status, 400);

    // sessionKey が無い cookie（別ドメインのみ）も拒否する
    const wrongDomain = await POST(
      request(
        `http://localhost/api/accounts/${anthropic.id}/anthropic-cookie`,
        "POST",
        {
          cookies:
            "# Netscape HTTP Cookie File\n.opencode.ai\tTRUE\t/\tTRUE\t4102444800\tsessionKey\tx\n",
        },
      ),
      context(anthropic.id),
    );
    assert.equal(wrongDomain.status, 400);

    const wrongProvider = await POST(
      request(
        `http://localhost/api/accounts/${openrouter.id}/anthropic-cookie`,
        "POST",
        { cookies: validCookies },
      ),
      context(openrouter.id),
    );
    assert.equal(wrongProvider.status, 400);

    const missing = await POST(
      request("http://localhost/api/accounts/missing/anthropic-cookie", "POST", {
        cookies: validCookies,
      }),
      context("missing"),
    );
    assert.equal(missing.status, 404);
  });

  it("deletes only the selected account cookie", async () => {
    setup();
    const account = createAccount({
      label: "Anthropic API",
      providers: ["anthropic"],
    });
    const cookiePath = accountAnthropicCookiePath(
      accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!),
    );

    await POST(
      request(
        `http://localhost/api/accounts/${account.id}/anthropic-cookie`,
        "POST",
        { cookies: validCookies },
      ),
      context(account.id),
    );
    assert.equal(existsSync(cookiePath), true);

    const response = await DELETE(
      request(
        `http://localhost/api/accounts/${account.id}/anthropic-cookie`,
        "DELETE",
      ),
      context(account.id),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, configured: false });
    assert.equal(existsSync(cookiePath), false);
  });
});
