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
import { readAnthropicCreditBaseline } from "@/lib/codexbar/providers/anthropic";
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
  const dataDir = mkdtempSync(join(tmpdir(), "leafcode-anthropic-baseline-api-"));
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

describe("/api/accounts/[id]/anthropic-baseline", () => {
  it("stores the baseline next to the account auth file", async () => {
    setup();
    const account = createAccount({
      label: "Anthropic API",
      providers: ["anthropic"],
    });
    const authPath = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);

    const response = await POST(
      request(
        `http://localhost/api/accounts/${account.id}/anthropic-baseline`,
        "POST",
        { baselineUsd: 100 },
      ),
      context(account.id),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, baselineUsd: 100 });
    assert.equal(readAnthropicCreditBaseline(authPath), 100);
    assert.match(
      readFileSync(join(authPath, "..", "anthropic.json"), "utf8"),
      /"creditBaselineUsd": 100/,
    );
  });

  it("rejects invalid amounts and accounts without Anthropic", async () => {
    setup();
    const anthropic = createAccount({
      label: "Anthropic API",
      providers: ["anthropic"],
    });
    const openrouter = createAccount({
      label: "OpenRouter",
      providers: ["openrouter"],
    });

    for (const baselineUsd of [0, -5, Number.NaN, 2_000_000]) {
      const invalid = await POST(
        request(
          `http://localhost/api/accounts/${anthropic.id}/anthropic-baseline`,
          "POST",
          { baselineUsd },
        ),
        context(anthropic.id),
      );
      assert.equal(invalid.status, 400);
    }

    const missingBody = await POST(
      request(
        `http://localhost/api/accounts/${anthropic.id}/anthropic-baseline`,
        "POST",
        {},
      ),
      context(anthropic.id),
    );
    assert.equal(missingBody.status, 400);

    const wrongProvider = await POST(
      request(
        `http://localhost/api/accounts/${openrouter.id}/anthropic-baseline`,
        "POST",
        { baselineUsd: 50 },
      ),
      context(openrouter.id),
    );
    assert.equal(wrongProvider.status, 400);

    const missing = await POST(
      request(
        "http://localhost/api/accounts/missing/anthropic-baseline",
        "POST",
        { baselineUsd: 50 },
      ),
      context("missing"),
    );
    assert.equal(missing.status, 404);
  });

  it("clears the baseline on DELETE", async () => {
    setup();
    const account = createAccount({
      label: "Anthropic API",
      providers: ["anthropic"],
    });
    const authPath = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);
    const configPath = join(authPath, "..", "anthropic.json");

    await POST(
      request(
        `http://localhost/api/accounts/${account.id}/anthropic-baseline`,
        "POST",
        { baselineUsd: 25.5 },
      ),
      context(account.id),
    );
    assert.equal(existsSync(configPath), true);

    const response = await DELETE(
      request(
        `http://localhost/api/accounts/${account.id}/anthropic-baseline`,
        "DELETE",
      ),
      context(account.id),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, baselineUsd: null });
    assert.equal(existsSync(configPath), false);
    assert.equal(readAnthropicCreditBaseline(authPath), null);
  });
});
