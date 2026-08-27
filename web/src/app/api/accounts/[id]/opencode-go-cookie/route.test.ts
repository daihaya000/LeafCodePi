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
import { accountOpenCodeCookiePath } from "@/lib/codexbar/browser-cookies";
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
  const dataDir = mkdtempSync(
    join(tmpdir(), "leafcode-opencode-go-cookie-api-"),
  );
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
.opencode.ai\tTRUE\t/\tTRUE\t4102444800\tsession\taccount-cookie
`;

describe("/api/accounts/[id]/opencode-go-cookie", () => {
  it("saves a valid account cookie without returning its contents", async () => {
    setup();
    const account = createAccount({
      label: "OpenCode Go 個人用",
      providers: ["opencode-go"],
    });

    const response = await POST(
      request(
        `http://localhost/api/accounts/${account.id}/opencode-go-cookie`,
        "POST",
        {
          cookies: validCookies,
        },
      ),
      context(account.id),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, configured: true });
    const path = accountOpenCodeCookiePath(
      accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!),
    );
    assert.equal(existsSync(path), true);
    assert.match(readFileSync(path, "utf8"), /session\taccount-cookie/);
  });

  it("rejects invalid cookies and accounts without OpenCode Go", async () => {
    setup();
    const opencodeGo = createAccount({
      label: "OpenCode Go",
      providers: ["opencode-go"],
    });
    const openrouter = createAccount({
      label: "OpenRouter",
      providers: ["openrouter"],
    });

    const invalid = await POST(
      request(
        `http://localhost/api/accounts/${opencodeGo.id}/opencode-go-cookie`,
        "POST",
        {
          cookies: "not a Netscape cookie",
        },
      ),
      context(opencodeGo.id),
    );
    assert.equal(invalid.status, 400);

    const wrongProvider = await POST(
      request(
        `http://localhost/api/accounts/${openrouter.id}/opencode-go-cookie`,
        "POST",
        {
          cookies: validCookies,
        },
      ),
      context(openrouter.id),
    );
    assert.equal(wrongProvider.status, 400);

    const missing = await POST(
      request(
        "http://localhost/api/accounts/missing/opencode-go-cookie",
        "POST",
        {
          cookies: validCookies,
        },
      ),
      context("missing"),
    );
    assert.equal(missing.status, 404);
  });

  it("deletes only the selected account cookie", async () => {
    setup();
    const account = createAccount({
      label: "OpenCode Go",
      providers: ["opencode-go"],
    });
    const authPath = accountAuthPath(
      account.id,
      process.env.PI_CODING_AGENT_DIR!,
    );
    const cookiePath = accountOpenCodeCookiePath(authPath);

    await POST(
      request(
        `http://localhost/api/accounts/${account.id}/opencode-go-cookie`,
        "POST",
        {
          cookies: validCookies,
        },
      ),
      context(account.id),
    );
    assert.equal(existsSync(cookiePath), true);

    const response = await DELETE(
      request(
        `http://localhost/api/accounts/${account.id}/opencode-go-cookie`,
        "DELETE",
      ),
      context(account.id),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, configured: false });
    assert.equal(existsSync(cookiePath), false);
  });
});
